// =======================================================
// TourEngine.js (no external dependency)
// Guided tour for GED Keepers: dims the whole page, cuts a spotlight around the
// step's target (an element, or a person on the graph), and shows a bubble.
//
// Built to fail safe: a step whose target is missing or not visible is skipped,
// any error ends the tour (and removes the dimming), and the tour can always be
// left with the Skip button or Esc. Nothing it adds is left behind afterwards.
//
//   TourEngine.init(network)                      // vis-network, for person steps
//   TourEngine.start(steps, { onStart, onEnd })
//
// step: {
//   type: "dom" | "node" | "center",
//   element: "#selector"          (dom)        node: "@I1@" (node)
//   title, text                   (HTML)
//   position: "left" | "right" | "below" | "above" | "center"   (preferred side; falls back)
//   radius: 90                    (node spotlight radius, px)
//   before(), after()             optional hooks (e.g. reveal a hidden button)
// }
// =======================================================

export class TourEngine {

    static steps = [];
    static currentStep = -1;
    static network = null;      // Vis.js network reference
    static active = false;
    static options = {};

    static overlay = null;      // full-page <canvas> that dims everything but the target
    static bubbleEl = null;
    static _onKey = null;
    static _onResize = null;

    static init(network) {
        this.network = network;
    }

    // ---------------------------------------------------
    // START / END
    // ---------------------------------------------------
    static start(steps, options = {}) {
        this.end();                       // never stack two tours
        this.steps = Array.isArray(steps) ? steps : [];
        this.options = options || {};
        this.active = true;
        this.currentStep = -1;

        try {
            if (this.options.onStart) this.options.onStart();
            this.createOverlay();
            this.createBubble();
            this._onKey = (e) => this.handleKey(e);
            this._onResize = () => { if (this.active) this.render(); };
            document.addEventListener("keydown", this._onKey, true);
            window.addEventListener("resize", this._onResize);
            this.go(1, 0);
        } catch (err) {
            console.error("Tour could not start:", err);
            this.end();
        }
    }

    static end() {
        const wasActive = this.active;
        this.active = false;
        try {
            const step = this.steps[this.currentStep];
            if (step && step.after) step.after();
        } catch (e) { /* ignore */ }

        if (this._onKey) document.removeEventListener("keydown", this._onKey, true);
        if (this._onResize) window.removeEventListener("resize", this._onResize);
        this._onKey = null;
        this._onResize = null;

        if (this.overlay) this.overlay.remove();
        if (this.bubbleEl) this.bubbleEl.remove();
        this.overlay = null;
        this.bubbleEl = null;
        this.currentStep = -1;

        if (wasActive && this.options.onEnd) {
            try { this.options.onEnd(); } catch (e) { console.error(e); }
        }
    }

    // ---------------------------------------------------
    // NAVIGATION
    // ---------------------------------------------------
    // Moves to the nearest usable step from `from` in direction `dir` (+1 / -1).
    static go(dir, from) {
        const previous = this.steps[this.currentStep];
        let i = from;
        while (i >= 0 && i < this.steps.length) {
            const step = this.steps[i];
            if (previous && previous !== step && previous.after) {
                try { previous.after(); } catch (e) { console.error(e); }
            }
            try {
                if (step.before) step.before();
                if (this.measure(step)) {      // visible and findable: use it
                    this.currentStep = i;
                    this.render();
                    return;
                }
                if (step.after) step.after();
            } catch (err) {
                console.error("Tour step failed, ending the tour:", err);
                this.end();
                return;
            }
            i += dir;
        }
        // ran off either end: a tour that goes forward past the last step is finished;
        // going back past the first step just stays where it is
        if (dir > 0 || this.currentStep < 0) this.end();
    }

    static next() { this.go(1, this.currentStep + 1); }
    static prev() { if (this.currentStep > 0) this.go(-1, this.currentStep - 1); }

    static handleKey(e) {
        if (!this.active) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.end(); }
        else if (e.key === "ArrowRight") { e.preventDefault(); this.next(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); this.prev(); }
    }

    // ---------------------------------------------------
    // TARGETS
    // ---------------------------------------------------
    // -> { left, top, width, height, round } in viewport coordinates, "center" for a
    // step with no target, or null when the target cannot be shown right now.
    static measure(step) {
        if (step.type === "center") return "center";

        if (step.type === "node") {
            if (!this.network || !step.node) return null;
            const pos = (this.network.getPositions([step.node]) || {})[step.node];
            if (!pos) return null;
            const dom = this.network.canvasToDOM(pos);
            const box = this.network.body.container.getBoundingClientRect();
            const r = step.radius || 90;
            const x = box.left + dom.x;
            const y = box.top + dom.y;
            if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;   // off screen
            return { left: x - r, top: y - r, width: 2 * r, height: 2 * r, round: true };
        }

        // "dom"
        const el = step.element && document.querySelector(step.element);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return null;     // hidden, collapsed or display:none
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, round: false };
    }

    // ---------------------------------------------------
    // RENDER THE CURRENT STEP
    // ---------------------------------------------------
    static render() {
        const step = this.steps[this.currentStep];
        if (!step || !this.active) return;
        try {
            if (step.type === "dom") {
                const el = document.querySelector(step.element);
                if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
            }
            const target = this.measure(step);
            if (!target) { this.next(); return; }
            this.drawSpotlight(target === "center" ? null : target);
            this.fillBubble(step);
            this.placeBubble(step, target === "center" ? null : target);
        } catch (err) {
            console.error("Tour step failed, ending the tour:", err);
            this.end();
        }
    }

    // ---------------------------------------------------
    // SPOTLIGHT (one full-page canvas, so panels are dimmed too)
    // ---------------------------------------------------
    static createOverlay() {
        const canvas = document.createElement("canvas");
        canvas.id = "tourSpotlight";
        Object.assign(canvas.style, {
            position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
            pointerEvents: "none", zIndex: "9000"
        });
        document.body.appendChild(canvas);
        this.overlay = canvas;
    }

    static drawSpotlight(target) {
        const canvas = this.overlay;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(window.innerWidth * dpr);
        canvas.height = Math.round(window.innerHeight * dpr);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
        if (!target) return;

        const pad = 8;
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        if (target.round) {
            ctx.arc(target.left + target.width / 2, target.top + target.height / 2, target.width / 2, 0, Math.PI * 2);
        } else if (ctx.roundRect) {
            ctx.roundRect(target.left - pad, target.top - pad, target.width + 2 * pad, target.height + 2 * pad, 8);
        } else {
            ctx.rect(target.left - pad, target.top - pad, target.width + 2 * pad, target.height + 2 * pad);
        }
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        // a thin outline so the spotlight reads even on a dark map
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (target.round) ctx.arc(target.left + target.width / 2, target.top + target.height / 2, target.width / 2, 0, Math.PI * 2);
        else ctx.rect(target.left - pad, target.top - pad, target.width + 2 * pad, target.height + 2 * pad);
        ctx.stroke();
    }

    // ---------------------------------------------------
    // BUBBLE
    // ---------------------------------------------------
    static createBubble() {
        const div = document.createElement("div");
        div.id = "tourBubble";
        Object.assign(div.style, {
            position: "fixed", zIndex: "10000", background: "#fff", border: "1px solid #ccc",
            borderRadius: "8px", padding: "12px 14px", width: "min(420px, 92vw)", boxSizing: "border-box",
            boxShadow: "0 6px 18px rgba(0,0,0,0.35)", fontFamily: "Arial, sans-serif", color: "#222",
            left: "0px", top: "0px", visibility: "hidden"
        });
        div.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
                <div id="tourTitle" style="font-weight:bold;font-size:15px;margin-bottom:6px;"></div>
                <button id="tourSkip" title="End the tour (Esc)" style="border:none;background:none;font-size:13px;color:#666;cursor:pointer;white-space:nowrap;">Skip tour &#10005;</button>
            </div>
            <div id="tourText" style="font-size:13px;line-height:1.45;margin-bottom:10px;"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                <button id="tourPrev" style="padding:4px 10px;cursor:pointer;">&larr; Back</button>
                <span id="tourCount" style="font-size:12px;color:#777;"></span>
                <button id="tourNext" style="padding:4px 12px;cursor:pointer;font-weight:bold;"></button>
            </div>`;
        document.body.appendChild(div);
        this.bubbleEl = div;
        div.querySelector("#tourPrev").onclick = () => this.prev();
        div.querySelector("#tourNext").onclick = () => this.next();
        div.querySelector("#tourSkip").onclick = () => this.end();
    }

    static fillBubble(step) {
        const b = this.bubbleEl;
        if (!b) return;
        b.querySelector("#tourTitle").innerHTML = step.title || "";
        b.querySelector("#tourText").innerHTML = step.text || "";
        const last = this.currentStep >= this.steps.length - 1;   // the tour ends on an always-available step
        b.querySelector("#tourNext").innerHTML = last ? "Finish" : "Next &rarr;";
        b.querySelector("#tourPrev").style.visibility = this.currentStep > 0 ? "visible" : "hidden";
        b.querySelector("#tourCount").textContent = `${this.currentStep + 1} / ${this.steps.length}`;
    }

    static placeBubble(step, target) {
        const b = this.bubbleEl;
        if (!b) return;
        b.style.visibility = "hidden";
        const bw = b.offsetWidth;
        const bh = b.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const gap = 18;
        const m = 8;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

        let x, y;
        if (!target) {
            x = (vw - bw) / 2;
            y = (vh - bh) / 2;
        } else {
            const cx = target.left + target.width / 2;
            const cy = target.top + target.height / 2;
            const big = target.width * target.height > 0.5 * vw * vh;       // a large area: sit inside it
            const spots = {
                left:  { x: target.left - gap - bw, y: cy - bh / 2 },
                right: { x: target.left + target.width + gap, y: cy - bh / 2 },
                below: { x: cx - bw / 2, y: target.top + target.height + gap },
                above: { x: cx - bw / 2, y: target.top - gap - bh },
            };
            const fits = (p) => p.x >= m && p.y >= m && p.x + bw <= vw - m && p.y + bh <= vh - m;
            const order = [step.position, "left", "right", "below", "above"].filter((p, i, a) => spots[p] && a.indexOf(p) === i);
            let chosen = null;
            if (big || step.position === "center") {
                chosen = { x: cx - bw / 2, y: target.top + 24 };
            } else {
                for (const name of order) { if (fits(spots[name])) { chosen = spots[name]; break; } }
                if (!chosen) chosen = spots[order[0]] || { x: (vw - bw) / 2, y: (vh - bh) / 2 };
            }
            x = chosen.x;
            y = chosen.y;
        }
        b.style.left = clamp(x, m, Math.max(m, vw - bw - m)) + "px";
        b.style.top = clamp(y, m, Math.max(m, vh - bh - m)) + "px";
        b.style.visibility = "visible";
    }
}
