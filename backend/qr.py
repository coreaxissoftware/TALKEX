"""
QR code rendering for device linking.

Generated server-side with the `qrcode` library rather than hand-written in
JavaScript. QR encoding involves Reed-Solomon error correction and precise bit
placement — a hand-rolled encoder is exactly the kind of code that LOOKS right
in a code review, renders SOMETHING that resembles a QR code, and then quietly
fails to actually scan. Using a real, widely-used library sidesteps that risk
entirely.
"""

import io

import qrcode
import qrcode.image.svg


def render_svg(text: str) -> str:
    """
    An inline-able SVG string for `text`.

    Deliberately encodes just the short pairing code, not a full URL — this
    project runs on localhost in development, and a localhost URL is not
    reachable from a phone scanning it on a different network anyway. The code
    itself, read as plain text by any scanner, is what actually works: type it
    into "Enter code" on the already-signed-in device.
    """
    image = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buffer = io.BytesIO()
    image.save(buffer)
    return buffer.getvalue().decode("utf-8")
