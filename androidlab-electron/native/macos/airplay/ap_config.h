// AndroidLab addition (not part of upstream RPiPlay): the advertised AirPlay display
// size. The GET /info response reports these as the receiver's widthPixels/heightPixels;
// the source device mirrors at (up to) this resolution. airplayscreen sets them from a
// CLI arg before starting the receiver; defaults match RPiPlay's original hardcoded
// 1920x1080. See PROVENANCE.md ("Local edits").
#ifndef AP_CONFIG_H
#define AP_CONFIG_H
extern int ap_display_width;
extern int ap_display_height;
#endif
