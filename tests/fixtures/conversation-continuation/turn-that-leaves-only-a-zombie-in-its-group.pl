#!/usr/bin/perl
# Stands in for an agent CLI's headless turn that, once its command has exited, leaves its process group holding nothing
# but a zombie: a process that has exited and that its parent never collects. A CLI is left so when its launcher exits
# first, a container's PID 1 that does not reap adopts it, and it then exits. Here the parent that never collects it is a
# process this script starts in a process group of its own, outside the turn's group, as PID 1 is.
#
# It reads the turn's message, starts that parent, which starts the zombie-to-be in this script's process group and never
# waits for it, waits until it has exited, prints Claude Code's JSON result "marmalade", and exits 0. The parent writes
# "<its pid> <the zombie's pid>" to the file STAND_IN_TURN_WRITES_ITS_PIDS_TO names, holds none of this script's stdin,
# stdout or stderr, and ends once the process that started this script has: it looks once a second, so a test that ends
# without ending it leaves it behind for a second at most. Perl, not sh: a shell cannot put a process in another process
# group (setpgid).
use strict;
use warnings;
use POSIX ();

my $message = do { local $/; <STDIN> };
my $started_by = getppid();
my $turn_group = getpgrp();
pipe(my $from_parent, my $to_this_script) or die "pipe: $!";
my $parent = fork() // die "fork: $!";
if ($parent == 0) {
  close $from_parent;
  open(STDIN, '<', '/dev/null') or POSIX::_exit(1);
  open(STDOUT, '>', '/dev/null') or POSIX::_exit(1);
  open(STDERR, '>', '/dev/null') or POSIX::_exit(1);
  setpgrp(0, 0) or POSIX::_exit(1);
  my $zombie = fork() // POSIX::_exit(1);
  if ($zombie == 0) {
    setpgrp(0, $turn_group);
    POSIX::_exit(0);
  }
  # As a job-control shell does, from both sides, so the zombie joins the turn's group whichever runs first.
  setpgrp($zombie, $turn_group);
  open(my $pids, '>', $ENV{STAND_IN_TURN_WRITES_ITS_PIDS_TO}) or POSIX::_exit(1);
  print $pids "$$ $zombie\n";
  close $pids;
  syswrite $to_this_script, "$zombie\n";
  close $to_this_script;
  sleep 1 while kill(0, $started_by);
  POSIX::_exit(0);
}
close $to_this_script;
my $zombie = <$from_parent>;
die "the parent that never collects the zombie did not start it\n" unless defined $zombie;
chomp $zombie;
# Until the zombie-to-be has exited, which it does as soon as it has joined this group: 10 ms naps wait little past that.
for (;;) {
  my ($state, $group) = state_and_group_of($zombie);
  die "the zombie was collected before this script saw it exit\n" if $state eq '';
  if ($state eq 'Z') {
    die "the zombie is in process group $group, not the turn's $turn_group\n" unless $group == $turn_group;
    last;
  }
  select(undef, undef, undef, 0.01);
}
print qq({"type":"result","subtype":"success","is_error":false,"result":"marmalade","permission_denials":[]}\n);
exit 0;

# The first letter of a process's state, and its process group: /proc/<pid>/stat on Linux, ps(1) elsewhere. An empty
# state once no such process is left.
sub state_and_group_of {
  my ($pid) = @_;
  if (open(my $stat, '<', "/proc/$pid/stat")) {
    my $line = <$stat>;
    # comm (field 2) is in parentheses and may hold spaces: fields 3 (state) and 5 (pgrp) follow the last ") ".
    my @fields = split / /, substr($line, rindex($line, ') ') + 2);
    return (substr($fields[0], 0, 1), $fields[2]);
  }
  my ($state, $group) = split ' ', `ps -o stat=,pgid= -p $pid`;
  return (substr($state // '', 0, 1), $group // -1);
}
