-- Approximate bounding boxes [south, west, north, east] for the Overpass bbox fallback (Liguria first).
-- Approximate by design: a bbox can include a few agencies just across a border; they are still shown with their city.
UPDATE regions SET bbox = '[43.75,7.49,44.68,10.07]' WHERE id = 'it-r-07';
UPDATE regions SET bbox = '[43.75,7.49,44.18,8.17]' WHERE id = 'it-p-im';
UPDATE regions SET bbox = '[43.97,7.94,44.55,8.65]' WHERE id = 'it-p-sv';
UPDATE regions SET bbox = '[44.25,8.57,44.68,9.53]' WHERE id = 'it-p-ge';
UPDATE regions SET bbox = '[44.02,9.43,44.45,10.07]' WHERE id = 'it-p-sp';
