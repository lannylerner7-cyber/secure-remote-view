import { QRCodeSVG } from "qrcode.react";
import { bitcoinPaymentUri } from "@/shared/bitcoin";

/** Generated locally: no wallet or invoice information is sent to a QR service. */
export function BitcoinQr({
  address,
  amount,
  reference,
  size = 208,
}: {
  address: string;
  amount?: string | number;
  reference?: string;
  size?: number;
}) {
  let uri: string;
  try {
    uri = bitcoinPaymentUri(address, amount, reference);
  } catch {
    return <p role="alert" className="text-sm">A valid Bitcoin mainnet address and amount are required for this QR code.</p>;
  }
  return (
    <QRCodeSVG
      value={uri}
      size={size}
      level="M"
      marginSize={4}
      bgColor="#ffffff"
      fgColor="#111111"
      title={amount === undefined ? "Bitcoin receiving wallet QR code" : "Bitcoin invoice QR code with exact amount"}
      role="img"
      data-testid="bitcoin-qr"
      data-payment-uri={uri}
      style={{ maxWidth: "100%", height: "auto" }}
    />
  );
}
