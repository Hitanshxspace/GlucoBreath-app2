/* GlucoBreath OLED renderer: draws the device's 128 x 64 screens as a dot matrix on a canvas. */
(function () {
  var W = 128, H = 64, PI = Math.PI;
  var off = document.createElement('canvas'); off.width = W; off.height = H;
  var o = off.getContext('2d', { willReadFrequently: true });
  var FD = '"Bricolage Grotesque","Helvetica Neue",Arial,sans-serif';
  var LIT = '#E6F4FF', UNLIT = '#0B1215', BG = '#070B0D';
  var D = { g: 6.4, ace: 1.0, eth: 0.12, t: 25.0, h: 48, linked: false, code: '000000' };
  var F5 = {" ":[0,0,0,0,0],"%":[35,19,8,100,98],".":[0,0,96,96,0],"/":[32,16,8,4,2],":":[0,0,20,0,0],"0":[62,81,73,69,62],"1":[0,66,127,64,0],"2":[114,73,73,73,70],"3":[33,65,73,77,51],"4":[24,20,18,127,16],"5":[39,69,69,69,57],"6":[60,74,73,73,49],"7":[65,33,17,9,7],"8":[54,73,73,73,54],"9":[70,73,73,41,30],"A":[124,18,17,18,124],"B":[127,73,73,73,54],"C":[62,65,65,65,34],"D":[127,65,65,65,62],"E":[127,73,73,73,65],"F":[127,9,9,9,1],"G":[62,65,65,81,115],"H":[127,8,8,8,127],"I":[0,65,127,65,0],"J":[32,64,65,63,1],"K":[127,8,20,34,65],"L":[127,64,64,64,64],"M":[127,2,28,2,127],"N":[127,4,8,16,127],"O":[62,65,65,65,62],"P":[127,9,9,9,6],"Q":[62,65,81,33,94],"R":[127,9,25,41,70],"S":[38,73,73,73,50],"T":[3,1,127,1,3],"U":[63,64,64,64,63],"V":[31,32,64,32,31],"W":[63,64,56,64,63],"X":[99,20,8,20,99],"Y":[3,4,120,4,3],"Z":[97,81,73,69,67],"a":[32,84,84,84,120],"b":[127,72,68,68,56],"c":[56,68,68,68,40],"d":[56,68,68,72,127],"e":[56,84,84,84,24],"f":[8,126,9,1,2],"g":[8,20,84,84,60],"h":[127,8,4,4,120],"i":[0,68,125,64,0],"j":[32,64,68,61,0],"k":[127,16,40,68,0],"l":[0,65,127,64,0],"m":[124,4,120,4,120],"n":[124,8,4,4,120],"o":[56,68,68,68,56],"p":[124,20,20,20,8],"q":[8,20,20,24,124],"r":[124,8,4,4,8],"s":[72,84,84,84,36],"t":[4,63,68,64,32],"u":[60,64,64,32,124],"v":[28,32,64,32,28],"w":[60,64,48,64,60],"x":[68,40,16,40,68],"y":[12,80,80,80,60],"z":[68,100,84,76,68]};

  function ease(t) { t = Math.max(0, Math.min(1, t)); var u = 1 - t; return 1 - u * u * u; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function btxt(s, x, y, al) {
    var w = s.length * 6 - 1; if (al === 'center') x -= Math.floor(w / 2); else if (al === 'right') x -= w;
    for (var i = 0; i < s.length; i++) {
      var g = F5[s.charAt(i)]; if (!g) continue;
      for (var c = 0; c < 5; c++) for (var r = 0; r < 7; r++) if ((g[c] >> r) & 1) o.fillRect(x + i * 6 + c, y + r, 1, 1);
    }
  }
  function btxtC(s, cx, y) { btxt(s, Math.round(cx), Math.round(y), 'center'); }
  function big(s, cx, y, size) { o.font = '700 ' + size + 'px ' + FD; o.textAlign = 'center'; o.textBaseline = 'top'; o.fillText(s, cx, y); }
  function circ(x, y, r, fill) { o.beginPath(); o.arc(x, y, r, 0, PI * 2); if (fill) o.fill(); else o.stroke(); }
  function rr(x, y, w, h, r, fill) { o.beginPath(); if (o.roundRect) o.roundRect(x, y, w, h, r); else o.rect(x, y, w, h); if (fill) o.fill(); else o.stroke(); }
  function drop(cx, cy, r) {
    o.fillStyle = '#fff'; circ(cx, cy, r, true);
    o.beginPath(); o.moveTo(cx, cy - 2 * r); o.lineTo(cx - r * .87, cy - r / 2); o.lineTo(cx + r * .87, cy - r / 2); o.closePath(); o.fill();
    o.fillStyle = '#000'; circ(cx - r / 3, cy + r / 4, Math.max(1, r / 5), true); o.fillStyle = '#fff';
  }
  function bar(x, y, w, h, f) {
    f = clamp(f, 0, 1); o.lineWidth = 1; rr(x + .5, y + .5, w - 1, h - 1, h / 2, false);
    var fw = Math.round((w - 4) * f); if (fw > 1) rr(x + 2, y + 2, fw, h - 4, Math.max(1, (h - 4) / 2), true);
  }
  function band(g) { return g < 3.9 ? 'LOW' : g <= 7.8 ? 'NORMAL' : g <= 11 ? 'HIGH' : 'VERY HIGH'; }
  function grp(c) { return c.slice(0, 3) + ' ' + c.slice(3, 6); }

  var SCREENS = {
    off: function (t) {
      drop(64, 24, 6);
      btxtC('NO DEVICE', 64, 40);
      if (Math.floor(t / 700) % 2 === 0) btxtC('Connect in app', 64, 53);
    },
    warm: function (t, op) {
      var f = op && op.frac != null ? op.frac : 0.62;
      btxtC('WARMING UP', 64, 3); drop(64, 28, 6 + 2 * Math.sin(t * .006));
      bar(14, 40, 100, 9, f); btxtC('Heating sensors ' + Math.round(f * 100) + '%', 64, 54);
    },
    home: function (t) {
      btxt(D.t.toFixed(1) + 'C', 1, 1); btxt(Math.round(D.h) + '%', 127, 1, 'right');
      if (D.linked) btxtC('BT', 64, 1);
      drop(64, 32, 7 + 2 * Math.sin(t * .004)); o.lineWidth = 1;
      for (var k = 0; k < 2; k++) { var p = ((t / 2400) + k * .5) % 1; if (p < .9) circ(64, 32, 13 + p * 10, false); }
      btxtC('PRESS TO START', 64, 54);
    },
    pair: function (t) {
      btxtC('PAIR CODE', 64, 1);
      big(grp(D.code), 64, 14, 21);
      btxtC('Same code in the app?', 64, 41);
      if (Math.floor(t / 600) % 2 === 0) btxtC('PRESS TO CONFIRM', 64, 53);
    },
    ready: function (t) {
      btxtC('GET READY', 64, 2);
      var s = ease(t / 400), off2 = Math.round((1 - s) * 40);
      o.font = '700 14px ' + FD; o.textAlign = 'center'; o.textBaseline = 'top';
      o.fillText('Blow for', 64 + off2, 13); o.fillText('5 seconds', 64 - off2, 31); o.lineWidth = 1;
      for (var i = 0; i < 4; i++) { var x = ((t / 8) + i * 16) % 80 + 24; o.beginPath(); o.moveTo(x, 50); o.lineTo(x + 4, 54); o.lineTo(x, 58); o.stroke(); }
    },
    blow: function (t) {
      btxtC('BLOW NOW', 64, 2);
      var rem = Math.max(1, 5 - Math.floor(t / 1000)); big(String(rem), 30, 14, 28);
      o.lineWidth = 1; circ(30, 32, 19 + Math.round(1.5 * Math.sin(t * .012)), false);
      for (var i = 0; i < 5; i++) { var p = (t * .0007 * (.8 + i * .17) + i * .37) % 1; circ(74 + i * 10 + 3 * Math.sin(t * .005 + i), 46 - p * 30, 2 + (i % 3), false); }
      bar(4, 56, 120, 7, t / 5000);
    },
    analyze: function (t) {
      var head = Math.floor(t / 90) % 8;
      for (var i = 0; i < 8; i++) {
        var a = i * PI / 4, x = 64 + Math.cos(a) * 15, y = 25 + Math.sin(a) * 15, d = (head - i + 8) % 8;
        if (d === 0) circ(x, y, 3, true); else if (d === 1) circ(x, y, 2, true); else if (d < 4) circ(x, y, 1, true); else o.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
      drop(64, 27, 4); btxtC('ANALYZING BREATH', 64, 52);
    },
    resA: function (t) {
      o.lineWidth = 1; circ(116, 4, 2, true); circ(123, 4, 2, false);
      btxtC('GLUCOSE LEVEL', 56, 1);
      big((D.g * ease(t / 1200)).toFixed(1), 64, 9, 28);
      btxtC('mmol/L', 64, 41);
      var by = Math.round(64 - ease((t - 600) / 700) * 13);
      rr(26, by, 76, 11, 3, true); o.fillStyle = '#000'; btxtC(band(D.g), 64, by + 2); o.fillStyle = '#fff';
    },
    resB: function (t) {
      o.lineWidth = 1; circ(116, 4, 2, false); circ(123, 4, 2, true);
      btxtC('BREATH DETAILS', 56, 1); o.fillRect(0, 11, 128, 1);
      btxt('Acetone  ' + D.ace.toFixed(2) + ' ppm', 0, 15); btxt('Ethanol  ' + D.eth.toFixed(2) + ' ppm', 0, 27);
      btxt('Temp ' + D.t.toFixed(1) + 'C  Hum ' + Math.round(D.h) + '%', 0, 39);
      if (Math.floor(t / 600) % 2 === 0) btxtC('Press to retest', 64, 54);
    }
  };

  var bgCache = {};
  function bgFor(scale, gap) {
    var k = scale + ':' + gap; if (bgCache[k]) return bgCache[k];
    var c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale; var x = c.getContext('2d');
    x.fillStyle = BG; x.fillRect(0, 0, c.width, c.height); x.fillStyle = UNLIT;
    for (var j = 0; j < H; j++) for (var i = 0; i < W; i++) x.fillRect(i * scale, j * scale, scale - gap, scale - gap);
    return bgCache[k] = c;
  }
  function render(canvas, name, t, op, scale, gap) {
    o.fillStyle = '#000'; o.fillRect(0, 0, W, H); o.fillStyle = '#fff'; o.strokeStyle = '#fff'; o.lineWidth = 1;
    (SCREENS[name] || SCREENS.off)(t, op);
    var d = o.getImageData(0, 0, W, H).data, x = canvas.getContext('2d');
    x.drawImage(bgFor(scale, gap), 0, 0); x.fillStyle = LIT; var s = scale - gap;
    for (var j = 0; j < H; j++) { var row = j * W * 4; for (var i = 0; i < W; i++) if (d[row + i * 4] > 120) x.fillRect(i * scale, j * scale, s, s); }
  }
  window.GBOled = { render: render, setData: function (p) { for (var k in p) D[k] = p[k]; }, data: D };
})();
