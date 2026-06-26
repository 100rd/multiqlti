const { HILParkingService } = require('../src/parking-service');

/**
 * Generates a mock task object with the given properties.
 */
function generateMockTask(id, type, description = '', payload = null) {
  return {
    id,
    type,
    description,
    payload
  };
}

module.exports = {
  generateMockTask
};
