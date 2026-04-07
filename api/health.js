const { config, handleApiRoute } = require("./_shared");

module.exports = async (req, res) => handleApiRoute(req, res, "/api/health");
module.exports.config = config;
