import test from "node:test";
import assert from "node:assert/strict";
import { movieFilename } from "../src/services/movie/movieFilename.js";

test("movie names use the tab term and padded local date/time without Windows-reserved separators", () => {
  const date = new Date(2026, 9, 3, 23, 21, 4);
  for (const term of ["3d", "mh", "lines", "areas", "flux", "force", "moment", "loss"]) {
    assert.equal(movieFilename(term, date), `${term}_2026-10-03_23-21-04.gif`);
  }
  assert.equal(movieFilename("areas", new Date(2027, 0, 1, 0, 0, 0)), "areas_2027-01-01_00-00-00.gif");
  assert.equal(movieFilename("../other", date), "movie_2026-10-03_23-21-04.gif");
  assert.throws(() => movieFilename("areas", new Date(NaN)), /дата/);
});
