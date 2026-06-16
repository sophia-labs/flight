import type { MatchSummary } from "../protocol/schema";

interface MatchBrowserProps {
  matches: MatchSummary[];
  selectedId: string | null;
  onSelect: (match: MatchSummary) => void;
}

export function MatchBrowser({ matches, selectedId, onSelect }: MatchBrowserProps) {
  return (
    <aside className="match-rail" aria-label="Match browser">
      <header className="rail-header">
        <div>
          <p className="eyebrow">Sweep</p>
          <h2 className="match-rail-title">{matches.length} matches</h2>
        </div>
      </header>
      <div className="match-list">
        {matches.map((match) => {
          const c = match.competence;
          const result =
            match.winnerTeam === "blue" ? "won" : match.winnerTeam === "red" ? "lost" : "draw";
          return (
            <button
              key={match.id}
              type="button"
              className={`match-card${match.id === selectedId ? " active" : ""}`}
              onClick={() => onSelect(match)}
            >
              <div className="match-card-head">
                <span className="match-model">{match.model}</span>
                <span className={`match-mode mode-${match.mode}`}>{match.mode}</span>
              </div>
              <div className="match-card-stats">
                <span className={`result-${result}`}>{result}</span>
                {c ? <span>{c.hits} hits</span> : null}
                {c ? <span>stall {(c.fracStalled * 100).toFixed(0)}%</span> : null}
                {match.fallbackRate > 0 ? (
                  <span className="warn">fb {(match.fallbackRate * 100).toFixed(0)}%</span>
                ) : null}
                <span className="cost">${match.costUsd.toFixed(3)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
