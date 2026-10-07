import { readPlants } from './plants.js';

// Builds the sowing calendar: one entry per plant and week, from the first
// sowing day to the last.
export function buildCalendar(season, today = new Date()) {
  return readPlants()
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
