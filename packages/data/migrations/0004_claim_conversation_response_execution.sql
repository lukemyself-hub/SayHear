ALTER TABLE generation_commands
  DROP CONSTRAINT generation_commands_status_check;

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_status_check
  CHECK (
    status IN (
      'prepared',
      'compiling',
      'running',
      'succeeded',
      'failed',
      'interrupted'
    )
  );
