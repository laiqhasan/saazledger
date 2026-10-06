# Real photo verification (offline, for the Mac)

This checks YOUR real photo (for example `IMG_20261001_120958.jpg`, 2276x4048) without uploading it anywhere.
Nothing is sent to the internet, no AI service is used, Shopify and Railway are not touched, and your original
photo is never changed.

## Option A: run the check on your Mac

1. Install Node.js 22 or newer from https://nodejs.org (the "LTS" or latest installer). Open the **Terminal** app.
2. Get the code (use the review branch):
   ```
   git clone --branch review/draft-only-inventory-media-fixes https://github.com/<your-account>/saazledger.git
   cd saazledger
   ```
   (If you already have the folder: `cd saazledger && git fetch && git checkout review/draft-only-inventory-media-fixes && git pull`.)
   If the checks live on a newer branch (ask who sent you this), use that branch name instead, `wp/realphoto-tools`.
3. Install: `npm ci`  (takes a minute or two)
4. Run it, giving the path to your photo. Tip: type `npx tsx scripts/verify-real-photo.ts ` (with a trailing space) and
   drag the photo from Finder into the Terminal window to paste its path:
   ```
   npx tsx scripts/verify-real-photo.ts ~/Pictures/IMG_20261001_120958.jpg
   ```
   Optional: `--out ~/Desktop/photo-check` to choose where results go, `--label "my real photo"` to add a title to the images.
5. Wait about 10-30 seconds. The report prints in the Terminal and the files are saved in
   `photo-verification-output/` inside the `saazledger` folder (it is git-ignored, so it never gets committed).

## What you get (in the output folder)

| File | What it is |
| --- | --- |
| `report.txt` | The readable report (what to paste back) |
| `report.json` | Same information for tools |
| `contact_sheet.png` | One picture: original, white background result (red box = jewellery), the bad 2048 square, crop recovery |
| `white_background.jpg` | The white-background image (2048x2048) |
| `crop_recovery.jpg` | The crop made from the TRUE original after a bad 2048 square |
| `bad_derivative_2048.jpg` | The simulated bad square image (used only to prove it is refused) |
| `original_copy.jpg` | A byte-identical copy of your photo (your own file is never modified) |
| `pipeline.log` | Technical log |

## How to read PASS / FAIL

The top of `report.txt` says **OVERALL RESULT: PASS** or **FAIL**. The command also ends with a non-zero exit code on FAIL.
Each line below it is `[PASS]`, `[FAIL]` or `[INFO]` (information only, never fails):

- **A1** ruler / forbidden object check should NOT fire (your photo has no ruler). FAIL means it wrongly saw a ruler.
- **F1** the whole jewellery is inside your original photo frame. FAIL means chain/earrings touch the photo edge.
- **B1-B5** the white-background image was made, is 2048x2048, shows the complete jewellery inside the canvas with padding
  on every side (see "padding per side" in the report), the corners are pure white, and the app would allow the "exact match" label.
- **C1-C4** after a bad 2048x2048 square, crop recovery refuses the square and uses the true original: the report shows
  the crop source is 2276x4048 with the same sha256 as your photo.
- **D1-D3** your original file's sha256 is identical before and after.
- **G1** no network or AI call was made.

Look at `contact_sheet.png` too: the jewellery (whole chain and both earrings) should sit fully inside the white square.

Important limit: this offline tool cannot call PhotoRoom, so it cuts the jewellery out with a simple local
colour-key stand-in. It verifies framing, padding, clipping, original handling and crop recovery, but NOT the edge
quality of the real PhotoRoom cut-out (use Option B for that).

## What to paste back

Open `report.txt`, copy everything, and paste it into the chat. Also attach `contact_sheet.png`. If something errors
out, paste the red error text from the Terminal.

## Option B: check in the app (Staging)

1. Open the app on **Staging** and go to the Media Pack Studio.
2. Upload `IMG_20261001_120958.jpg` (the original, not a screenshot).
3. Choose **Product Accuracy - Exact Cutout** for the white background (not an AI presentation mode).
4. Generate. The white image should show the complete chain and both earrings with white margins.
5. Open the **crop editor** and confirm it says **Original** with **2276x4048** (not 2048x2048).
6. Tell us what you see, with screenshots of the white image and the crop editor.

## About the synthetic test files

The repo's automated tests draw their own pretend jewellery photos. They now run in a throw-away temporary folder, so
they never create files in the repo's `data` / `uploads` folders and can never mix with your real photos.
Any file in `data/uploads/photos` with a name like your photo's may be such a drawn test image; do not treat it as real.
