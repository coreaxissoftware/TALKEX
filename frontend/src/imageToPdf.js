/**
 * Wraps a canvas's current contents into a real single-page PDF, entirely in
 * the browser.
 *
 * "Scan PDF" has to produce an actual PDF, not a JPEG with a misleading
 * ".pdf" name — so this builds one by hand rather than pulling in a PDF
 * library for a single use. A one-page PDF embedding a JPEG is a small,
 * well-defined byte layout: a handful of objects, the image dropped in as a
 * DCTDecode XObject (a JPEG's own encoding, so no re-compression), and an
 * xref table pointing at each object's byte offset.
 *
 * Takes a canvas rather than a raw file so the edit sheet's rotation and
 * compression choices are already baked into the pixels by the time this
 * runs — this function only ever wraps, it never edits.
 */
// Wraps N canvases into one multi-page PDF (one canvas → one page). This is
// the real builder; canvasToPdfBlob below is just the single-page shorthand.
//
// Object layout: 1 = Catalog, 2 = Pages, then three objects per page —
// Page (3 + i*3), Image XObject (4 + i*3), Content stream (5 + i*3). The
// /Kids array on the Pages object lists every page object in order, and the
// xref table records each object's byte offset so a reader can seek to it.
export async function canvasesToPdfBlob(canvases, quality = 0.85) {
  const pages = [];
  for (const canvas of canvases) {
    const jpegBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality));
    pages.push({
      jpegBytes: new Uint8Array(await jpegBlob.arrayBuffer()),
      width: canvas.width, height: canvas.height,
    });
  }
  if (pages.length === 0) throw new Error("no pages to write");

  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = {};
  let pos = 0;

  function write(bytes) {
    chunks.push(bytes);
    pos += bytes.length;
  }
  function writeObject(number, bytes) {
    offsets[number] = pos;
    write(bytes);
  }

  write(encoder.encode("%PDF-1.4\n"));

  const pageObjNums = pages.map((_, i) => 3 + i * 3);

  writeObject(1, encoder.encode(
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));

  writeObject(2, encoder.encode(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] ` +
    `/Count ${pages.length} >>\nendobj\n`));

  pages.forEach((page, i) => {
    const pageObj = 3 + i * 3;
    const imageObj = 4 + i * 3;
    const contentObj = 5 + i * 3;
    const { jpegBytes, width, height } = page;

    writeObject(pageObj, encoder.encode(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`));

    writeObject(imageObj, encoder.encode(
      `${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`));
    write(jpegBytes);
    write(encoder.encode("\nendstream\nendobj\n"));

    // The content stream just scales the 1x1 image-space unit square up to the
    // full page and paints it — everything a one-image page needs.
    const content = encoder.encode(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ`);
    writeObject(contentObj, encoder.encode(
      `${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n`));
    write(content);
    write(encoder.encode("\nendstream\nendobj\n"));
  });

  const objectCount = 2 + pages.length * 3; // highest object number in the file
  const xrefStart = pos;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objectCount; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  write(encoder.encode(xref));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return new Blob([bytes], { type: "application/pdf" });
}

// Single-page shorthand — unchanged callers keep working.
export async function canvasToPdfBlob(canvas, quality = 0.85) {
  return canvasesToPdfBlob([canvas], quality);
}
