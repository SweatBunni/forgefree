const fs = require("fs");
const { processApiRequest } = require("../backend");

async function readBodyText(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return "";
  }

  if (typeof req.body === "string") {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleApiRoute(req, res, pathname) {
  try {
    const apiResponse = await processApiRequest({
      method: req.method || "GET",
      pathname,
      bodyText: await readBodyText(req),
    });

    if (!apiResponse) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    for (const [header, value] of Object.entries(apiResponse.headers || {})) {
      res.setHeader(header, value);
    }

    if (apiResponse.type === "json") {
      res.status(apiResponse.status).send(apiResponse.body);
      return;
    }

    if (apiResponse.type === "file") {
      const buffer = await fs.promises.readFile(apiResponse.filePath);
      res.status(apiResponse.status).send(buffer);
      return;
    }

    res.status(500).json({ error: "Unsupported API response type." });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

module.exports = {
  config: {
    api: {
      bodyParser: false,
      maxDuration: 60,
    },
  },
  handleApiRoute,
};
