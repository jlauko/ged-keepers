export default class Attachment {
  constructor(filename, type) {
    this.filename = filename;
    this.type = type;
    this.url = null; // to be set when file is read
  }

  // ✅ async method inside a class
  async loadFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        this.url = e.target.result;
        resolve(this);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ✅ async method for uploading
  async upload(file, entityId) {
    if (!isAdmin()) return;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("entityId", entityId);

    try {
      const res = await fetch("http://localhost:4000/attachments", {
        method: "POST",
        body: formData,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      });

      const data = await res.json();
      console.log("Uploaded:", data);
      alert("Upload successful");
    } catch (err) {
      console.error("Upload failed:", err);
      alert("Upload failed");
    }
  }
}