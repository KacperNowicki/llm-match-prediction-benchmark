import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

test("local tournament workflow MVP", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "LLM Match Prediction Benchmark" })).toBeVisible();

  await page.getByLabel("Tournament name").fill("MVP Spring Test");
  await page.getByRole("textbox", { name: "League", exact: true }).fill("LCK");
  await page.getByRole("textbox", { name: "Season", exact: true }).fill("2026");
  await page.getByLabel("Stage").fill("Spring");
  await page.getByLabel("Round label").fill("W1D1");
  await page.getByLabel("Default best of").selectOption("3");
  await page.getByRole("button", { name: "Add Tournament" }).click();
  await expect(page.getByRole("heading", { name: "MVP Spring Test" })).toBeVisible();
  await expect(page.getByLabel("Action confirmations")).toContainText("Done: Creating tournament");

  await page.getByLabel("New LLM name").fill("Perplexity");
  await page.getByRole("button", { name: "Add LLM" }).click();
  await expect(page.getByLabel("Rename Perplexity")).toHaveValue("Perplexity");
  await page.getByLabel("Rename Perplexity").fill("Perplexity Labs");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Rename Perplexity Labs")).toHaveValue("Perplexity Labs");
  await page.getByRole("button", { name: "Move Perplexity Labs up" }).click();

  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByRole("button", { name: "Schedule", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Schedule TSV").fill(
    "Match ID\tDate\tStage\tRound\tBO\tTeam1\tTeam2\n" +
      "M1\t2026-05-20 15:00:00\tSpring\tW1D1\t3\tT1\tDK\n" +
      "M2\t2026-05-20 18:00:00\tSpring\tW1D1\t3\tGEN\tHLE\n" +
      "M3\t2026-05-18 15:00:00\tSpring\tPast\t3\tPAST\tOLD\n" +
      "M4\t2026-05-23 15:00:00\tSpring\tFuture\t3\tTBD\tG2"
  );
  await page.getByRole("button", { name: "Import / Update Schedule" }).click();
  await expect(page.getByText("T1 vs DK")).toBeVisible();
  await expect(page.getByText("GEN vs HLE")).toBeVisible();

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const secondMatchRow = page.getByRole("row", { name: /M2/ });
  await expect(secondMatchRow).toBeVisible();
  await secondMatchRow.getByRole("button", { name: "Spring", exact: true }).click();
  await page.getByLabel("Editable cell value").fill("Spring Edited");
  await page.getByLabel("Accept edit").click();
  await expect(secondMatchRow.getByRole("button", { name: "Spring Edited" })).toBeVisible();
  const futureMatchRow = page.getByRole("row", { name: /M4/ });
  await expect(futureMatchRow).toBeVisible();
  await futureMatchRow.getByRole("button", { name: "TBD", exact: true }).click();
  await page.getByLabel("Editable cell value").fill("KC");
  await page.getByLabel("Accept edit").click();
  await expect(page.getByRole("row", { name: /M4.*KC vs G2/ })).toBeVisible();

  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByLabel("Legacy TSV import").fill("Match ID\tStage\tRound\tBO\tTeam1\tTeam2\tActual Winner\tActual Score\tgpt\nM1\tSpring\tW1D1\t3\tT1\tDK\t\t\tT1 2-0");
  await page.getByRole("button", { name: "Import Legacy TSV" }).click();
  await expect(page.locator("section.panel", { hasText: "Legacy Sheet Import" }).getByText("1 tournaments, 1 matches, 1 predictions, 0 new LLMs")).toBeVisible();

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(page.getByRole("group", { name: "Prompt tournaments" }).getByLabel("LCK | MVP Spring Test")).toBeChecked();
  await expect(page.getByLabel("Generated prompt")).not.toContainText("TBD");
  await expect(page.getByLabel("Generated prompt")).not.toContainText("PAST vs OLD");
  await page.getByLabel("Prompt date scope").selectOption("upcoming");
  await expect(page.getByLabel("Generated prompt")).toContainText("All matches are Best of 3");
  await expect(page.getByLabel("Generated prompt")).toContainText("1. T1 vs DK");

  await page.getByRole("button", { name: "Predictions", exact: true }).click();
  await page.getByLabel("Prediction model").selectOption({ label: "Perplexity Labs" });
  await expect(page.getByLabel("Raw predictions")).toHaveValue("");
  await page.getByLabel("Raw predictions").fill("T1 2-0\nGEN 2-1");
  await page.getByRole("button", { name: "Parse" }).click();
  await expect(page.getByRole("cell", { name: "valid" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Save Reviewed" }).click();

  await page.getByRole("button", { name: "Results", exact: true }).click();
  await expect(page.getByLabel("Raw results")).toHaveValue("");
  await page.getByLabel("Raw results").fill("T1\t2-0\nHLE\t2-1\nPAST\t2-0\nG2\t2-0");
  await page.getByRole("button", { name: "Parse" }).click();
  await expect(page.getByRole("cell", { name: "HLE", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save Results" }).click();

  await page.getByRole("button", { name: "LLMs", exact: true }).click();
  await expect(page.getByRole("row", { name: /T1 vs DK/ }).first()).toBeVisible();
  await expect(page.locator(".prediction-matrix th", { hasText: "Consensus" })).toBeVisible();
  await expect(page.locator(".prediction-pill.exact", { hasText: "T1 2-0" }).first()).toBeVisible();
  await expect(page.locator(".prediction-pill.wrong-winner", { hasText: "GEN 2-1" }).first()).toBeVisible();
  await expect(page.locator(".prediction-pill.derived", { hasText: "GEN 2-1" })).toBeVisible();
  await page.locator(".prediction-matrix .prediction-pill.missing").first().click();
  await page.getByLabel("Editable cell value").fill("T1 2-0");
  await page.getByLabel("Accept edit").click();
  await expect(page.locator(".prediction-pill.exact", { hasText: "T1 2-0" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Scores", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Perplexity Labs" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Perplexity Labs.*2\/8/ })).toBeVisible();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByLabel("Export mode").selectOption("extended");
  await page.getByRole("button", { name: "Generate TSV" }).click();
  await expect(page.getByLabel("TSV export")).toContainText("Perplexity");
  await expect(page.getByLabel("TSV export")).toContainText("M1\tSpring\tW1D1\t3\tT1\tDK\tT1\t2-0");

  await page.getByRole("button", { name: "Tweets", exact: true }).click();
  await expect(page.getByRole("group", { name: "Tweet tournaments" }).getByLabel("LCK | MVP Spring Test")).toBeChecked();
  await page.getByLabel("Tweet draft type").selectOption("league");
  await expect(page.getByRole("textbox", { name: "Tweet draft" })).toContainText("LCK LLM benchmark update");

  await fs.mkdir(path.join(process.cwd(), "artifacts", "screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", `workflow-${Date.now()}.png`),
    fullPage: true
  });
});

test("Leaguepedia tournament picker can search and open a selected event", async ({ page }) => {
  const fakeTournament = {
    id: "tournament_leaguepedia_mock",
    name: "LCK 2026 Rounds 1-2",
    league: "LCK",
    season: 2026,
    stage: null,
    roundLabel: null,
    dateStart: "2026-04-01",
    dateEnd: "2026-05-31",
    defaultBestOf: 3,
    status: "active",
    matchCount: 2,
    completedCount: 0
  };

  await page.route("**/api/leaguepedia/tournaments?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tournaments: [
          {
            name: "LCK 2026 Rounds 1-2",
            overviewPage: "LCK/2026 Season/Rounds 1-2",
            dateStart: "2026-04-01",
            dateEnd: "2026-05-31",
            league: "LoL Champions Korea",
            region: "Korea",
            tournamentLevel: "Primary",
            isOfficial: true,
            year: "2026"
          }
        ]
      })
    });
  });

  await page.route("**/api/leaguepedia/tournaments/add", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ tournament: fakeTournament, schedule: { applied: 2, skippedManualResults: 0 } })
    });
  });

  await page.route("**/api/tournaments/tournament_leaguepedia_mock", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tournament: fakeTournament,
        matches: [
          {
            id: "match_mock_1",
            tournamentId: fakeTournament.id,
            matchOrder: 1,
            externalMatchId: "LCK2026-1",
            dateTimeUtc: "2026-04-01 08:00:00",
            stage: "Regular Season",
            roundLabel: "Round 1",
            bestOf: 3,
            team1: "T1",
            team2: "DK",
            actualWinner: null,
            actualScore: null,
            actualSource: null,
            manualOverride: false,
            predictionCount: 0
          },
          {
            id: "match_mock_2",
            tournamentId: fakeTournament.id,
            matchOrder: 2,
            externalMatchId: "LCK2026-2",
            dateTimeUtc: "2026-04-02 08:00:00",
            stage: "Regular Season",
            roundLabel: "Round 1",
            bestOf: 3,
            team1: "GEN",
            team2: "HLE",
            actualWinner: null,
            actualScore: null,
            actualSource: null,
            manualOverride: false,
            predictionCount: 0
          }
        ],
        scores: []
      })
    });
  });

  await page.goto("/");
  await page.getByLabel("Leaguepedia tournament search").fill("LCK");
  await page.getByLabel("Leaguepedia season").fill("2026");
  await page.getByRole("button", { name: "Search Leaguepedia tournaments" }).click();
  await expect(page.getByText("LCK 2026 Rounds 1-2")).toBeVisible();
  await page.locator(".leaguepedia-option").filter({ hasText: "LCK 2026 Rounds 1-2" }).click();
  await expect(page.getByRole("heading", { name: "LCK 2026 Rounds 1-2" })).toBeVisible();
  await expect(page.getByText("T1 vs DK")).toBeVisible();

  await page.goto("/");
  await page.getByLabel("Leaguepedia page URL").fill("https://lol.fandom.com/wiki/LCK/2026_Season/Rounds_1-2");
  await page.getByRole("button", { name: "Add Leaguepedia page" }).click();
  await expect(page.getByRole("heading", { name: "LCK 2026 Rounds 1-2" })).toBeVisible();
  await expect(page.getByText("T1 vs DK")).toBeVisible();
});

test("active tournament can be removed after confirmation", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Tournament name").fill("Remove Me Cup");
  await page.getByRole("textbox", { name: "League", exact: true }).fill("LCK");
  await page.getByRole("textbox", { name: "Season", exact: true }).fill("2026");
  await page.getByRole("button", { name: "Add Tournament" }).click();
  await expect(page.getByRole("heading", { name: "Remove Me Cup" })).toBeVisible();

  await page.getByRole("button", { name: "Remove tournament" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove tournament?" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Remove Me Cup" })).toBeVisible();

  await page.getByRole("button", { name: "Remove tournament" }).click();
  await dialog.getByRole("button", { name: "Remove Tournament" }).click();
  await expect(page.getByRole("button", { name: /Remove Me Cup/ })).toHaveCount(0);
});
