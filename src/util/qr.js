import QRCode from 'qrcode'

export async function renderQrCode(canvas, text) {
  await QRCode.toCanvas(canvas, text, {
    width: 160,
    margin: 1,
    color: { dark: '#2B2250', light: '#FFFFFF' },
  })
}
