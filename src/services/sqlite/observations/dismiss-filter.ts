export const NOT_DISMISSED_SQL =
  "NOT EXISTS (SELECT 1 FROM observation_feedback f WHERE f.observation_id = o.id AND f.signal_type = 'dismissed')";
