@rem npm runs package scripts in cmd.exe on Windows, which has no "exec" (S-034a,
@rem D-093). cmd looks in the current folder first, so a script ending in
@rem "exec node ..." runs node through this file; elsewhere the shell's own
@rem exec is used and this file is never read.
@%*
