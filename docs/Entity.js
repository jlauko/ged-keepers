export default class Entity {
    constructor(id, type) {
        this.id = id;       // matches vis.js node or cluster id
        this.type = type;   // "node" or "cluster"
        this.attachments = [];
    }

    async addAttachment(file, name) {
        if (!(file instanceof Blob)) {
            throw new Error("addAttachment expects a File or Blob");
        }

        // Read file as DataURL
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

        // Build attachment metadata
        const attachment = {
            id: crypto.randomUUID(),
            filename: file.name,
            name: name || file.name,
            type: file.type,
            file: file,
            url: dataUrl
        };  
        this.attachments.push(attachment);

        const formData = new FormData();
        formData.append("file", file);
        formData.append("nodeId", this.id);
        formData.append("name", name || file.name);

        try {
            const res = await fetch("http://localhost:4000/attachments", {
                method: "POST",
                body: formData,
                headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
            });

            const data = await res.json();
            console.log("Uploaded:", data);
            // update local attachment record with server-side values (id/url/name)
            const idx = this.attachments.findIndex(a => a.id === attachment.id);
            if (idx !== -1) {
                this.attachments[idx].id = data.id || this.attachments[idx].id;
                this.attachments[idx].url = data.url || this.attachments[idx].url;
                this.attachments[idx].filename = data.filename || this.attachments[idx].filename;
                this.attachments[idx].name = data.name || this.attachments[idx].name;
            }
            alert("Upload successful");
        } catch (err) {
            console.error("Upload failed:", err);
            alert("Upload failed");
        }
   
    }

    getAttachments() {
        return this.attachments;
    }

    openAttachment(url,type) {
        console.log("Opening attachment - Entity Class");
        if (type.includes("image")) {
            const win = window.open();
            win.document.write(`<img src="${url}" style="max-width:100%; max-height:100%;">`);
        } else if (type.includes("pdf")) {
            // Convert base64 data URL to Blob
            const byteCharacters = atob(url.split(',')[1]);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'application/pdf' });

            // Create a safe object URL
            const blobUrl = URL.createObjectURL(blob);

            // Open in new tab
            window.open(blobUrl, "_blank");
        }
    }

    downloadAttachment(url, filename) {
        console.log(`Downloading attachment: ${filename}`);
        const byteCharacters = atob(url.split(',')[1]);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        const blobUrl = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        a.click();

        // Clean up
        URL.revokeObjectURL(blobUrl);
    }

    async deleteAttachment(attachmentId, nodeId) {
        // Find index of the attachment with matching id
        const index = this.attachments.findIndex(att => att.id === attachmentId);

        if (index !== -1) {
            // Remove it from the array
            this.attachments.splice(index, 1);
            console.log(`Attachment ${attachmentId} deleted `);
        } else {
            console.warn(`Attachment ${attachmentId} not found`);
        }
        // Call backend delete API
        try {
            await fetch(`http://localhost:4000/attachments/${attachmentId}`, {
                method: "DELETE",
                headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
            });
        } catch (e) {
            console.error("Failed to delete attachment on server:", e);
        }
    }

    async updateAttachmentName(attachmentId, newName) {
        const idx = this.attachments.findIndex(att => att.id === attachmentId);
        if (idx === -1) {
            console.warn(`Attachment ${attachmentId} not found locally`);
        }

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers.Authorization = `Bearer ${authToken}`;

            const res = await fetch(`http://localhost:4000/attachments/${attachmentId}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ name: newName })
            });

            const data = await res.json();
            // update local cache
            if (idx !== -1) {
                this.attachments[idx].name = data.name || newName;
            }
            return data;
        } catch (e) {
            console.error("Failed to update attachment name on server:", e);
            throw e;
        }
    }
}