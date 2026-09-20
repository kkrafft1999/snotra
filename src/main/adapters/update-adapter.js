'use strict';

function createUpdateAdapter(updateService) {
  return {
    getCurrentVersion() {
      return updateService.getCurrentVersion();
    },
    checkForUpdate(options) {
      return updateService.checkForUpdate(options);
    },
    ignoreVersion(version) {
      return updateService.ignoreVersion(version);
    },
    downloadUpdate(options) {
      return updateService.downloadUpdate(options);
    },
    cancelDownload() {
      return updateService.cancelDownload();
    },
    discardDownload() {
      return updateService.discardDownload();
    },
    installUpdate() {
      return updateService.installUpdate();
    },
  };
}

module.exports = {
  createUpdateAdapter,
};
