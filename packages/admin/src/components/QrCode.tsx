/**
 * A QR code drawn as SVG from the `otpauth://` link (D-077: the server
 * returns the link only; the browser draws it). The encoder is `uqr` (MIT,
 * no dependencies, D-081). The picture is built from React elements, never
 * from markup text, so nothing is injected and no inline style is needed
 * under the admin's CSP. Screen readers get a label; the same key is
 * offered as text beside it for anyone who can't scan.
 */
import { encode } from "uqr";

export function QrCode(props: { readonly value: string; readonly label: string }) {
  const qr = encode(props.value, { ecc: "M", border: 4 });
  const size = qr.size;
  let path = "";
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${String(x)} ${String(y)}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      width="220"
      height="220"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#111111" />
    </svg>
  );
}
