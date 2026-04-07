const { config, handleApiRoute } = require("../_shared");

module.exports = async (req, res) => handleApiRoute(req, res, "/api/export/jar");
module.exports.config = config;
