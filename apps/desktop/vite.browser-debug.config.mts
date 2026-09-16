// TEMP (agent debug only): plain-browser renderer dev server used to
// reproduce canvas issues outside Electron. Mirrors the renderer section of
// electron.vite.config.ts. Safe to delete.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const schemaSrc = fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  resolve: {
    alias: { "@mcpeasy/schema": schemaSrc },
  },
  plugins: [
    react(),
    {
      name: "debug-raf-shim",
      transformIndexHtml() {
        // The agent's headless browser never fires requestAnimationFrame
        // (backgrounded renderer). Shim it with setTimeout so React Flow's
        // queued-fitView path and d3 transitions can run like a real window.
        return [
          {
            tag: "script",
            injectTo: "head-prepend",
            children: `
              (function () {
                // Install IMMEDIATELY (before module graph loads) so d3-timer
                // and React Flow capture the shim, not the dead native rAF.
                // Hybrid: race native rAF against a 24ms timeout; whichever
                // fires first wins. In a live window native wins; in this
                // headless (backgrounded, frame-less) window the timer wins.
                (function () {
                  var nativeRaf = window.requestAnimationFrame.bind(window);
                  var nativeCancel = window.cancelAnimationFrame.bind(window);
                  var seq = 1;
                  var live = {};
                  window.requestAnimationFrame = function (cb) {
                    var id = seq++;
                    var done = false;
                    var fire = function () {
                      if (done || !live[id]) return;
                      done = true;
                      delete live[id];
                      cb(performance.now());
                    };
                    live[id] = true;
                    nativeRaf(fire);
                    setTimeout(fire, 24);
                    return id;
                  };
                  window.cancelAnimationFrame = function (id) { delete live[id]; };
                  console.warn("[debug] hybrid rAF installed");
                })();
                (function () {

                  // Same root cause: no frames means ResizeObserver callbacks
                  // never deliver, so React Flow can never measure nodes.
                  // Minimal shim: deliver observed elements' border-box once
                  // per observe() and poll for size changes.
                  var RealRO = window.ResizeObserver;
                  function ShimRO(cb) {
                    var targets = new Map();
                    var self = this;
                    function measure(el) {
                      var r = el.getBoundingClientRect();
                      return { inlineSize: r.width, blockSize: r.height, rect: r };
                    }
                    function deliver() {
                      var entries = [];
                      targets.forEach(function (last, el) {
                        var m = measure(el);
                        if (last && last.inlineSize === m.inlineSize && last.blockSize === m.blockSize) return;
                        targets.set(el, m);
                        entries.push({
                          target: el,
                          contentRect: m.rect,
                          borderBoxSize: [m],
                          contentBoxSize: [m],
                          devicePixelContentBoxSize: [m],
                        });
                      });
                      if (entries.length) cb(entries, self);
                    }
                    this.observe = function (el) { targets.set(el, null); setTimeout(deliver, 0); };
                    this.unobserve = function (el) { targets.delete(el); };
                    this.disconnect = function () { targets.clear(); };
                    var poll = setInterval(deliver, 200);
                  }
                  window.ResizeObserver = ShimRO;
                  console.warn("[debug] ResizeObserver shimmed (poll)");
                })();
              })();
            `,
          },
        ];
      },
    },
  ],
  server: { port: 5199, strictPort: true },
});
