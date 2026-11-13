;(function (root, factory) {
  const api = factory()
  if (typeof module === "object" && module && module.exports) module.exports = api
  else root.BrandAccent = api
})(typeof self !== "undefined" ? self : this, function () {
  "use strict"

  const MIN_ACCENT_LUMINANCE = 0.23
  const INK_SWITCH_LUMINANCE = 0.18
  const DARK_INK = "#1c1405"
  const LIGHT_INK = "#ffffff"

  function parseHexColor(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex || "")
    if (!match) return null
    const value = Number.parseInt(match[1], 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  }

  function relativeLuminance(rgb) {
    const linear = rgb.map((value) => {
      const channel = value / 255
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  }

  function toHex(rgb) {
    return "#" + rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")
  }

  function clampBrandAccent(hex) {
    let rgb = parseHexColor(hex)
    if (!rgb) return null

    if (relativeLuminance(rgb) < MIN_ACCENT_LUMINANCE) {
      let low = 0
      let high = 1
      for (let i = 0; i < 24; i++) {
        const amount = (low + high) / 2
        const candidate = rgb.map((channel) => channel + (255 - channel) * amount)
        if (relativeLuminance(candidate) < MIN_ACCENT_LUMINANCE) low = amount
        else high = amount
      }
      rgb = rgb.map((channel) => channel + (255 - channel) * high)
    }

    const luminance = relativeLuminance(rgb)
    return {
      color: toHex(rgb),
      ink: luminance > INK_SWITCH_LUMINANCE ? DARK_INK : LIGHT_INK,
      luminance,
    }
  }

  return { clampBrandAccent, relativeLuminance }
})
