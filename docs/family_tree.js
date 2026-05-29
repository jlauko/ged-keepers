/**
 * Handles user login by collecting email and password and calling Login().
 */
async function loginUser() {
    const email = document.getElementById("emailpanel").value;
    const password = document.getElementById("passwordpanel").value;
    Login(email, password);
}

/**
 * Attempts to log in a user with the provided email and password.
 * @param {string} email - The user's email address.
 * @param {string} password - The user's password.
 * @returns {Promise<Object|null>} The login response data or null on failure.
 */
async function Login(email, password) {
    let data = null;
    const response = await fetch("/login", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            email,
            password,
        }),
    });
    if (response.ok) {
        data = await response.json();
    }
    return data;
}

/**
 * Checks if the current user is an admin.
 * @returns {boolean} True if the user is an admin, false otherwise.
 */
function isAdmin() { return userRole === "admin"; }

/**
 * Returns the authorization headers for authenticated requests.
 * @returns {Object} The headers object with Authorization if logged in.
 */
function authHeaders() {
    return authToken ? { Authorization: "Bearer " + authToken } : {};
}

/**
 * Loads evidence data for edges from the backend and updates the edges dataset.
 * @param {Object} userData - The user data object.
 * @returns {Promise<void>}
 */
async function loadEvidencefromBackend(userData) {
    // ...existing code...
}

/**
 * Saves the current evidence data for edges to the backend.
 * @returns {Promise<Object|null>} The response object or null on failure.
 */
async function saveEvidenceToBackend() {
    // ...existing code...
}

/**
 * Loads node information (biographies, attachments) from the backend.
 * @param {Object} userData - The user data object.
 * @returns {Promise<void>}
 */
async function loadNodeInformation(userData) {
    // ...existing code...
}

/**
 * Caches an image for an attachment and sets its orientation.
 * @param {Object} att - The attachment object.
 * @returns {Promise<Object>} The updated attachment object.
 */
function cacheImage(att) {
    // ...existing code...
}

/**
 * Opens the biography editor modal for a node.
 * @param {string} nodeId - The node ID.
 * @param {string} name - The name of the node.
 */
function openBioEditor(nodeId, name) {
    // ...existing code...
}

/**
 * Closes the biography editor modal.
 */
function closeBioEditor() {
    // ...existing code...
}

/**
 * Saves biography data for the currently edited node.
 * @returns {Promise<void>}
 */
async function saveBioData() {
    // ...existing code...
}

/**
 * Updates an individual node's biography and attachments in the backend.
 * @param {string} nodeId - The node ID.
 * @param {Object} bioData - The biography data object.
 * @returns {Promise<Object|null>} The response object or null on failure.
 */
async function UpdateIndividualNode(nodeId, bioData) {
    // ...existing code...
}

/**
 * Initiates the process to add an attachment to the currently edited node.
 */
async function BioAddAttachment() {
    // ...existing code...
}

/**
 * Displays node information in the context display panel.
 * @param {string} nodeId - The node ID.
 */
function displayNodeInfo(nodeId) {
    // ...existing code...
}

/**
 * Displays or hides the pin indicator in the info center title.
 * @param {boolean} showPin - Whether to show the pin indicator.
 */
function displayPinIndicator(showPin) {
    // ...existing code...
}

/**
 * Displays cluster information in the context display panel.
 * @param {Object} cluster - The cluster object.
 * @param {string} clusterID - The cluster ID.
 */
function displayClusterInfo(cluster, clusterID) {
    // ...existing code...
}
