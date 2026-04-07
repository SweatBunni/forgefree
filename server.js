const express = require("express");
const path = require("path");
const fs = require("fs");

const { processApiRequest } = require("./backend");

const app = express();
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ["text/*", "application/json"], limit: "5mb" }));

app.all("/api/*", async (req, res) => {
  try {
    const bodyText =
      req.method === "GET" || req.method === "HEAD"
        ? ""
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body || {});

    const apiResponse = await processApiRequest({
      method: req.method || "GET",
      pathname: req.path,
      bodyText,
    });

    if (!apiResponse) {
      return res.status(404).json({ error: "Not found." });
    }

    if (apiResponse.type === "json") {
      for (const [header, value] of Object.entries(apiResponse.headers || {})) {
        res.setHeader(header, value);
      }
      return res.status(apiResponse.status).send(apiResponse.body);
    }

    if (apiResponse.type === "file") {
      for (const [header, value] of Object.entries(apiResponse.headers || {})) {
        res.setHeader(header, value);
      }
      return res.status(apiResponse.status).sendFile(apiResponse.filePath);
    }

    return res.status(500).json({ error: "Unsupported API response type." });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("*", async (req, res) => {
  const requestPath = req.path === "/" ? "index.html" : req.path.replace(/^\/+/, "");
  const filePath = path.join(publicDir, requestPath);

  if (filePath.startsWith(publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }

  return res.sendFile(path.join(publicDir, "index.html"));
});

module.exports = app;
