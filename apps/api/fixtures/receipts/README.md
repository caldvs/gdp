# Golden receipts

Real bill photos with what's printed on them, for `npm run golden -w apps/api` (see `scripts/golden-receipts.ts`). It reads each photo with the real bill reader and checks the lines add up to the printed total.

For each bill, add the photo and a JSON file with the same name:

```json
{ "totalPence": 6475, "lines": 9, "servicePence": 720 }
```

Only `totalPence` is required. Crop out card slips and anything personal before committing a photo, and strip its location (`exiftool -all= -tagsfromfile @ -Orientation -ICC_Profile -overwrite_original photo.jpg`): the pre-commit hook refuses photos with GPS in them.

Aim for 10–20 that cover what goes wrong: long receipts, multi-quantity lines, discounts, service included or optional, handwritten totals, poor light, a photo at an angle.
