// Cloudflare R2 (S3-compatible) client for attachment storage.
//
// Env vars (set in Render's Environment tab, never committed):
//   R2_ACCOUNT_ID          - Cloudflare account id
//   R2_ACCESS_KEY_ID       - R2 API token key id
//   R2_SECRET_ACCESS_KEY   - R2 API token secret
//   R2_BUCKET              - bucket name
//
// If any are missing, `configured` is false and the attachment routes
// return 503 instead of crashing the server.

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
} = process.env;

const configured = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET
);

let client = null;
if (configured) {
  client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log(`R2 configured: bucket "${R2_BUCKET}", account ${R2_ACCOUNT_ID.slice(0, 6)}…, ` +
    `key ${R2_ACCESS_KEY_ID.slice(0, 4)}… (${R2_SECRET_ACCESS_KEY.length}-char secret)`);
} else {
  console.warn("WARNING: R2 is not configured - attachment upload/serve/delete will 503. " +
    `present: ${["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"].filter(k => process.env[k]).join(",") || "none"}`);
}

function isNotFound(err) {
  return (
    err &&
    (err.name === "NoSuchKey" ||
      err.name === "NotFound" ||
      err.Code === "NoSuchKey" ||
      err.$metadata?.httpStatusCode === 404)
  );
}

// Store a buffer. contentType is best-effort metadata.
async function putObject(key, body, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );
}

// Returns the raw GetObjectCommand output; `.Body` is a Node Readable stream.
async function getObject(key) {
  return client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

async function deleteObject(key) {
  await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

async function objectExists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

module.exports = {
  configured,
  bucket: R2_BUCKET,
  putObject,
  getObject,
  deleteObject,
  objectExists,
  isNotFound,
};
