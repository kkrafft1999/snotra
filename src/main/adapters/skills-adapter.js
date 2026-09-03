'use strict';

/**
 * Port-Adapter für den Skill-Service: schmale Oberfläche für den Chat-Core,
 * damit dieser nichts über Dateisystem, System-Skill-Verzeichnis oder Cache
 * weiß.
 */
function createSkillsAdapter(skillsService) {
  return {
    async getActiveSkills(options) {
      return skillsService.getActiveSkills(options);
    },
  };
}

module.exports = {
  createSkillsAdapter,
};
