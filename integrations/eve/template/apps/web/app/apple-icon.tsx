import { ImageResponse } from "next/og";
import { EveImageMark } from "./_components/eve-image-mark";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#050505",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <EveImageMark size={122} />
    </div>,
    size,
  );
}
