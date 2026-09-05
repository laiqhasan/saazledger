import crypto from 'crypto';
import { db } from '../db/database';
import { findItemBySkuOrAlias } from './skuService';
import { recordSaleFifo, handleOrderReversal, getItemById } from './inventoryService';

/**
 * Verifies Shopify Webhook HMAC-SHA256 signature
 */
export function verifyShopifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string,
  secret: string
): boolean {
  if (!hmacHeader || !secret) return false;

  const generatedHash = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

export interface ProcessWebhookResult {
  status: 'processed' | 'ignored' | 'already_processed' | 'failed';
  message: string;
  affectedItems?: string[];
}

/**
 * Processes incoming Shopify Order or Refund Webhooks idempotently
 */
export function processShopifyOrderWebhook(
  topic: string,
  payload: any
): ProcessWebhookResult {
  const orderId = String(payload.id || payload.order_id || '');
  if (!orderId) {
    return { status: 'failed', message: 'Missing order ID in payload' };
  }

  // 1. Determine normalized event type
  let eventType = 'order_placed';
  if (topic.includes('cancelled') || topic.includes('cancel')) {
    eventType = 'order_cancelled';
  } else if (topic.includes('refund')) {
    eventType = 'refund_created';
  } else if (topic.includes('updated')) {
    eventType = 'order_updated';
  }

  // 2. Check if this exact event was already processed (Deduplication)
  const existingEvent = db.prepare(`
    SELECT status FROM order_events
    WHERE source = 'shopify' AND external_order_id = ? AND event_type = ?
  `).get(orderId, eventType) as { status: string } | undefined;

  if (existingEvent && existingEvent.status === 'processed') {
    return {
      status: 'already_processed',
      message: `Shopify order ${orderId} event "${eventType}" was already processed. Skipped to prevent duplicate stock deduction.`,
    };
  }

  const eventId = `evt_shopify_${orderId}_${eventType}_${Date.now()}`;

  // 3. Process according to event type inside a transaction
  return db.transaction(() => {
    const affectedItems: string[] = [];

    if (eventType === 'order_placed' || eventType === 'order_updated') {
      const lineItems = payload.line_items || [];
      const customerName = payload.customer
        ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim() || 'Online Customer'
        : 'Online Customer';

      for (const line of lineItems) {
        const lineId = String(line.id || '');
        const sku = (line.sku || '').trim();
        if (!sku) continue;

        // Check if this specific line item was already processed
        const lineProcessed = db.prepare(`
          SELECT 1 FROM order_events
          WHERE source = 'shopify' AND external_order_id = ? AND external_line_id = ? AND event_type = 'order_placed'
        `).get(orderId, lineId);

        if (lineProcessed) continue;

        const found = findItemBySkuOrAlias(sku);
        if (found) {
          const item = getItemById(found.itemId);
          if (item && item.quantity >= line.quantity) {
            const unitPrice = parseFloat(line.price) || item.selling_price;
            recordSaleFifo({
              itemId: item.id,
              quantitySold: line.quantity,
              salePricePerUnit: unitPrice,
              channel: 'SaazAura.com (Shopify)',
              externalOrderId: `Shopify Order #${payload.name || orderId}`,
              notes: `Customer: ${customerName}`,
            });

            affectedItems.push(`${item.sku} (-${line.quantity} pcs)`);

            // Record line-level order event
            db.prepare(`
              INSERT OR REPLACE INTO order_events (
                id, source, external_order_id, external_line_id, event_type, status, payload, processed_at
              ) VALUES (?, 'shopify', ?, ?, 'order_placed', 'processed', ?, CURRENT_TIMESTAMP)
            `).run(`evt_line_${orderId}_${lineId}`, orderId, lineId, JSON.stringify(line));
          }
        }
      }
    } else if (eventType === 'order_cancelled') {
      // Find all movements from this order and restore stock
      const priorSales = db.prepare(`
        SELECT * FROM stock_movements
        WHERE channel = 'SaazAura.com (Shopify)' AND external_order_id LIKE ? AND type = 'sale'
      `).all(`%${payload.name || orderId}%`) as Array<{
        item_id: string;
        quantity_delta: number;
        sku: string;
      }>;

      for (const sale of priorSales) {
        const qtyToRestore = Math.abs(sale.quantity_delta);
        handleOrderReversal({
          itemId: sale.item_id,
          quantity: qtyToRestore,
          isRestockable: true,
          reason: `Order Cancellation: ${payload.cancel_reason || 'Customer requested cancellation'}`,
          channel: 'SaazAura.com (Shopify)',
          externalOrderId: `Shopify Order #${payload.name || orderId}`,
        });
        affectedItems.push(`${sale.sku} (+${qtyToRestore} pcs restored)`);
      }
    } else if (eventType === 'refund_created') {
      // Process refunded line items
      const refundLineItems = payload.refund_line_items || [];
      for (const rLine of refundLineItems) {
        const lineItem = rLine.line_item;
        if (!lineItem || !lineItem.sku) continue;

        const found = findItemBySkuOrAlias(lineItem.sku);
        if (found) {
          const qty = rLine.quantity || 1;
          const isRestock = rLine.restock_type !== 'no_restock';

          handleOrderReversal({
            itemId: found.itemId,
            quantity: qty,
            isRestockable: isRestock,
            reason: `Refund: ${rLine.note || 'Inspected return/refund'}`,
            channel: 'SaazAura.com (Shopify)',
            externalOrderId: `Refund for #${orderId}`,
          });
          affectedItems.push(`${lineItem.sku} (+${qty} refunded/inspected)`);
        }
      }
    }

    // Record top-level event
    db.prepare(`
      INSERT OR REPLACE INTO order_events (
        id, source, external_order_id, external_line_id, event_type, status, payload, processed_at
      ) VALUES (?, 'shopify', ?, NULL, ?, 'processed', ?, CURRENT_TIMESTAMP)
    `).run(eventId, orderId, eventType, JSON.stringify(payload));

    return {
      status: 'processed',
      message: `Processed Shopify ${eventType} for order #${payload.name || orderId}`,
      affectedItems,
    };
  })();
}
