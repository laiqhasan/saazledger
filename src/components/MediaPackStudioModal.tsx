import React from 'react';
import { MediaPackStudioModal as MediaPackStudioModalImpl } from './MediaPackStudioModal.impl';
import { BackgroundIsolationModeControl } from './BackgroundIsolationModeControl';

export type MediaPackStudioModalProps = React.ComponentProps<typeof MediaPackStudioModalImpl>;

/**
 * Public Media Pack Studio entrypoint.
 *
 * The original studio remains intact in MediaPackStudioModal.impl.tsx. This
 * wrapper adds one global isolation-strategy control without coupling that UI to
 * the very large gallery-builder component. The selected mode is persisted in
 * system_settings.bg_removal_provider and is consumed by the backend hybrid
 * PhotoRoom/Gemini isolation pipeline.
 */
export const MediaPackStudioModal: React.FC<MediaPackStudioModalProps> = (props) => (
  <>
    <MediaPackStudioModalImpl {...props} />
    {props.isOpen ? <BackgroundIsolationModeControl /> : null}
  </>
);
