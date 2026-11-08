-- PIGEONMAN: THE HOUSE casual account leaderboard. Keep this board identity and rules immutable.
INSERT INTO game_lb_boards
  (namespace, id, rules_version, direction, min_score, max_score, min_duration_ms, max_duration_ms, `open`)
VALUES
  ('production', 'escape-score-v1', 'v1', 'desc', 0, 1000000, 1000, 1800000, TRUE);
