// =======================================================
// TourEngine.js (No Intro.js dependency)
// Graph-aware guided tour system for GED Keepers
// =======================================================

export class TourEngine {

    static steps = [];
    static currentStep = 0;

    static spotlightCanvas = null;
    static bubbleEl = null;

    static network = null;   // Vis.js network reference

    // ---------------------------------------------------
    // INIT
    // ---------------------------------------------------
    static init(network) {
        this.network = network;
    }

    // ---------------------------------------------------
    // START TOUR
    // ---------------------------------------------------
    static start(steps) {
        this.steps = steps || [];
        this.currentStep = 0;

        this.createBubble();
        this.createSpotlightCanvas();

        this.showStep();
    }

    // ---------------------------------------------------
    // STEP NAVIGATION
    // ---------------------------------------------------
    static next() {
        if (this.currentStep < this.steps.length - 1) {
            this.currentStep++;
            this.showStep();
        } else {
            this.end();
        }
    }

    static prev() {
        if (this.currentStep > 0) {
            this.currentStep--;
            this.showStep();
        }
    }

    // ---------------------------------------------------
    // MAIN ROUTER
    // ---------------------------------------------------
    static showStep() {

        const step = this.steps[this.currentStep];
        console.log("Showing step:", this.currentStep, step);

        if (step.transition === "static") {
            console.log("Static transition - not clearing spotlight or bubble");
        } else {
            this.clearSpotlight();
            this.hideBubble();
        }

        if (!step) return;

        // NODE STEP (GRAPH)
        if (step.type === "node") {
            this.showNodeStep(step);
        }

        // DOM STEP
        if (step.type === "dom") {
            console.log("Calling showBubble for dom step:", step);
            this.showDomStep(step);
        }
    }

    // ---------------------------------------------------
    // NODE STEP
    // ---------------------------------------------------
    static showNodeStep(step) {

        const nodeId = step.node;

        if (!nodeId || !this.network) return;

        console.log("Focusing on node:", nodeId);

//        this.network.focus(nodeId, { scale: 1.1, animation: true });
        this.network.selectNodes([nodeId]);

        this.showSpotlight(nodeId, step.radius || 120);

        this.showBubble(
            step.title || "Node",
            step.text || "",
            step
        );
    }

    // ---------------------------------------------------
    // DOM STEP
    // ---------------------------------------------------
    static showDomStep(step) {

        const el = document.querySelector(step.element);

        console.log("dom step element:", el, step.element);

        if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
        }

        console.log("calling showBubble for dom step:", step);

        this.showDomSpotlight(step.element);

        this.showBubble(
            step.title || "Info",
            step.text || "",
            step
        );
    }

    // ---------------------------------------------------
    // SPOTLIGHT
    // ---------------------------------------------------
    static createSpotlightCanvas() {

        if (this.spotlightCanvas) return;

        const canvas = document.createElement("canvas");

        canvas.id = "tourSpotlight";
        canvas.style.position = "absolute";
        canvas.style.top = "0";
        canvas.style.left = "0";
        canvas.style.width = "70%";
        canvas.style.height = "100%";
        canvas.style.pointerEvents = "none";
        canvas.style.zIndex = "9000";

        document.getElementById("mynetwork").appendChild(canvas);

        this.spotlightCanvas = canvas;

        window.addEventListener("resize", () => this.resizeCanvas());
    }

    static resizeCanvas() {
        if (!this.spotlightCanvas) return;
        this.spotlightCanvas.width = this.spotlightCanvas.offsetWidth;
        this.spotlightCanvas.height = this.spotlightCanvas.offsetHeight;
    }

    static showSpotlight(nodeId, radius = 120) {

        if (!this.network) return;

        const canvas = this.spotlightCanvas;
        const ctx = canvas.getContext("2d");

        this.resizeCanvas();

        const posObj = this.network.getPositions([nodeId]);
        const pos = posObj?.[nodeId];

        if (!pos) return;

        const dom = this.network.canvasToDOM(pos);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // dark overlay
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // cut hole
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(dom.x, dom.y, radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalCompositeOperation = "source-over";
    }

    
    static showDomSpotlight(element) {

        if (!this.network) return;

        const el = document.querySelector(element);

        if (!el) return;

        const rect = el.getBoundingClientRect();

        const canvas = this.spotlightCanvas;
        const ctx = canvas.getContext("2d");

        this.resizeCanvas();

        if (!rect) return;

        const dom = this.network.canvasToDOM(rect);

    //    ctx.clearRect(0, 0, canvas.width, canvas.height);

        // dark overlay
     //   ctx.fillStyle = "rgba(0,0,0,0.65)";
     //   ctx.fillRect(0, 0, canvas.width, canvas.height);

        // cut hole
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.fillRect(dom.left, dom.top, dom.width, dom.height);
        ctx.fill();

        ctx.globalCompositeOperation = "source-over";
    }

    static clearSpotlight() {
        if (!this.spotlightCanvas) return;

        const ctx = this.spotlightCanvas.getContext("2d");
        ctx.clearRect(
            0,
            0,
            this.spotlightCanvas.width,
            this.spotlightCanvas.height
        );
    }

    // ---------------------------------------------------
    // BUBBLE
    // ---------------------------------------------------
    static createBubble() {

        if (this.bubbleEl) return;

        const div = document.createElement("div");

        div.id = "tourBubble";
        div.style.position = "absolute";
        div.style.zIndex = "10000";
        div.style.background = "white";
        div.style.border = "1px solid #ccc";
        div.style.borderRadius = "8px";
        div.style.padding = "12px";
        div.style.maxWidth = "320px";
        div.style.boxShadow = "0 4px 10px rgba(0,0,0,0.2)";

        div.innerHTML = `
            <div id="tourTitle" style="font-weight:bold;margin-bottom:6px;"></div>
            <div id="tourText" style="font-size:13px;margin-bottom:10px;"></div>

            <div style="display:flex;justify-content:space-between;">
                <button id="tourPrev">← Back</button>
                <button id="tourNext">Next →</button>
            </div>
        `;

        document.body.appendChild(div);

        this.bubbleEl = div;

        document.getElementById("tourPrev").onclick = () => this.prev();
        document.getElementById("tourNext").onclick = () => this.next();
    }

    static showBubble(title, text, step) {

        console.log("Showing bubble:", title, text, step);
        if (!this.bubbleEl) return;

        document.getElementById("tourTitle").innerHTML = title;
        document.getElementById("tourText").innerHTML = text;

        this.bubbleEl.style.display = "block";

        if (step.type === "node") {
            this.positionBubbleNearNode(step.node);
        } else {
            console.log("Positioning bubble near element for step:");
            this.positionBubbleNearElement(step.element,step);
        }

    }
    static positionBubbleNearElement(selector, step) {

        const el = document.querySelector(selector);
        const bubble = this.bubbleEl;

        if (!el || !bubble) return;

        const rect = el.getBoundingClientRect();

        console.log("Element bounding rect:", rect);

        const bubbleWidth = bubble.offsetWidth || 400;
        const bubbleHeight = bubble.offsetHeight || 120;

        const padding = 30;

        if (step.position === "insideTop") {
            bubble.style.left = `${rect.left + (rect.width / 2) - (bubbleWidth / 2)}px`;
            bubble.style.top = `${rect.top + padding}px`;
            return;
        } else if (step.position === "outsideleft") {
            bubble.style.left = `${rect.left - bubbleWidth - padding}px`;
            bubble.style.top = `${rect.top + (rect.height / 2) - (bubbleHeight / 2)}px`;
            return;
        } else if (step.position === "outsideright") {
            bubble.style.left = `${rect.right + padding}px`;
            bubble.style.top = `${rect.top + (rect.height / 2) - (bubbleHeight / 2)}px`;
            return;
        } 

    }
    static positionBubbleNearNode(nodeId) {

        const pos = this.network.getPositions([nodeId])[nodeId];
        if (!pos) return;

        const dom = this.network.canvasToDOM(pos);

        const bubble = this.bubbleEl;

        const offset = 60;

        let x = dom.x + offset;
        let y = dom.y - offset;

        // prevent going off screen
        const maxX = window.innerWidth - 300;
        const maxY = window.innerHeight - 200;

        if (x > maxX) x = dom.x - offset - 250;
        if (y < 50) y = dom.y + offset;

        bubble.style.position = "fixed";
        bubble.style.left = x + "px";
        bubble.style.top = y + "px";
    }
    static hideBubble() {
        if (this.bubbleEl) {
            this.bubbleEl.style.display = "none";
        }
    }

    // ---------------------------------------------------
    // END TOUR
    // ---------------------------------------------------
    static end() {
        this.hideBubble();
        this.clearSpotlight();

        this.currentStep = 0;
    }
}