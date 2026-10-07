import { lesePflanzen } from './pflanzen.js';

// Erstellt den Aussaatkalender: ein Eintrag pro Pflanze und Woche, vom ersten
// bis zum letzten Saattag.
export function erstelleKalender(season, today = new Date()) {
  return lesePflanzen()
    .filter((plant) => plant.sowFrom.getMonth() <= season.lastMonth)
    .map((plant) => ({
      plant: plant.name,
      weeks: weeksBetween(plant.sowFrom, plant.sowUntil),
      overdue: plant.sowUntil < today,
    }));
}

function weeksBetween(from, until) {
  const weeks = [];
  for (let day = new Date(from); day <= until; day.setDate(day.getDate() + 7)) {
    weeks.push(new Date(day));
  }
  return weeks;
}
