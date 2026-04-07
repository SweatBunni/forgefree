const { config, handleApiRoute } = require("../_shared");

module.exports = async (req, res) => handleApiRoute(req, res, "/api/export/source");
module.exports.config = config;
