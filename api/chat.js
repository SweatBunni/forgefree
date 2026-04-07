const { config, handleApiRoute } = require("./_shared");

module.exports = async (req, res) => handleApiRoute(req, res, "/api/chat");
module.exports.config = config;
