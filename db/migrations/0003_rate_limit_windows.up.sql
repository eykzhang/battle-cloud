-- Submission rate limiting, shared by every API instance.
--
-- The limiter was in-memory, which meant N instances enforced N times the configured
-- limit. That is wrong the moment the API scales past one instance, and the deployment
-- target autoscales.
--
-- A fixed window per (client, bucket), where the bucket is the window-aligned timestamp
-- the API computes. Aligned buckets rather than windows that start at a client's first
-- request: two instances have to agree on where a window begins without coordinating,
-- and arithmetic on a shared clock is the cheapest way to agree.

CREATE TABLE rate_limit_windows (
    client_key   text        NOT NULL,
    window_start timestamptz NOT NULL,
    count        integer     NOT NULL CHECK (count >= 0),
    PRIMARY KEY (client_key, window_start)
);

-- For the sweep, which deletes whole expired windows rather than per-client rows.
CREATE INDEX rate_limit_windows_expiry_idx ON rate_limit_windows (window_start);
