import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Renders a QR code for any string (a join link, a profile link, …) as a
 * self-contained data-URL image — no network, so it works offline and under
 * the app's strict CSP (data: images are allowed). Used for share-by-QR of
 * groups/channels/communities and for a user's own "add me" code.
 */
export default function QrView({ value, size = 200 }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!value) { setUrl(null); return; }
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then((dataUrl) => { if (!cancelled) setUrl(dataUrl); })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [value, size]);

  if (!url) {
    return <div style={{ width: size, height: size, background: "#fff", borderRadius: 10 }}/>;
  }
  return (
    <img src={url} width={size} height={size} alt="QR code"
         style={{ borderRadius: 10, background: "#fff", padding: 8, display: "block" }}/>
  );
}
