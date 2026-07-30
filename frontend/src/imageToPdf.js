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
export async function canvasToPdfBlob(canvas, quality = 0.85) {
  const jpegBlob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality));
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  const width = canvas.width;
  const height = canvas.height;

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

  writeObject(1, encoder.encode(
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));

  writeObject(2, encoder.encode(
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));

  writeObject(3, encoder.encode(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
    "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"));

  writeObject(4, encoder.encode(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`));
  write(jpegBytes);
  write(encoder.encode("\nendstream\nendobj\n"));

  // The content stream just scales the 1x1 image-space unit square up to the
  // full page and paints it — everything a one-image page needs.
  const content = encoder.encode(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ`);
  writeObject(5, encoder.encode(
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n`));
  write(content);
  write(encoder.encode("\nendstream\nendobj\n"));

  const xrefStart = pos;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let n = 1; n <= 5; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
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
