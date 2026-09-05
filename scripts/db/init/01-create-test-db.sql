-- Runs once on first initialization of the concord_pgdata volume.
-- Provides an isolated test database alongside the development database so
-- integration tests never touch dev data.
CREATE DATABASE concord_test;
