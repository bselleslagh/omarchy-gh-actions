#!/usr/bin/perl
# Shows one desktop notification, the way omarchy-notification-send does, but
# takes what it says on stdin instead of on the command line.
#
# A process's arguments are readable by every local account (/proc/<pid>/cmdline,
# ps), and omarchy-notification-send hands its headline and description on to
# busctl as arguments as well. Workflow, branch and job names from a private repo
# must not be readable that way. Here they come in over a pipe, and leave over the
# session bus socket, which only your account can reach. The command line is a
# fixed program and this file's path, nothing else.
#
# Input: one line of JSON on stdin,
#   {"app": "...", "replaceId": 0, "summary": "...", "body": "...",
#    "urgency": 0|1|2, "hints": {"omarchy-glyph": "...", ...}}
# where every hint is a string. It calls org.freedesktop.Notifications.Notify,
# the same method omarchy-notification-send calls, and prints the id it returns.
#
# Exit: 0 shown (the id is on stdout), 1 not shown, 3 sent but no answer.
#
# Only core Perl modules, so nothing beyond Omarchy's own dependencies.

use strict;
use warnings;
use IO::Socket::UNIX;
use Socket qw(SOCK_STREAM);
use JSON::PP ();

my $sent = 0;
sub fail { exit($sent ? 3 : 1) }

$SIG{ALRM} = \&fail;
$SIG{PIPE} = 'IGNORE';
alarm 10;

my $MAX_INPUT = 64 * 1024;

# ---------- Input ----------

my $line = <STDIN>;
fail() unless defined $line && length($line) <= $MAX_INPUT;
my $in = eval { JSON::PP->new->utf8->decode($line) };
fail() unless ref $in eq 'HASH';

# Text the bus will accept: no NUL, no lone surrogates, bounded.
sub clean {
  my ($value, $max) = @_;
  return '' if !defined $value || ref $value;
  my $text = "$value";
  $text =~ s/\x00//g;
  $text =~ s/[\x{D800}-\x{DFFF}]/\x{FFFD}/g;
  return substr($text, 0, $max);
}

my $app = clean($in->{app}, 256);
my $summary = clean($in->{summary}, 2048);
my $body = clean($in->{body}, 32768);
my $replace = $in->{replaceId};
$replace = 0 unless defined $replace && !ref $replace && $replace =~ /^\d{1,10}$/ && $replace <= 0xFFFFFFFF;
my $urgency = $in->{urgency};
$urgency = 1 unless defined $urgency && !ref $urgency && $urgency =~ /^[012]$/;

my @hints = (['urgency', 'y', $urgency]);
if (ref $in->{hints} eq 'HASH') {
  for my $key (sort keys %{ $in->{hints} }) {
    next unless $key =~ /^[a-z0-9-]{1,64}$/;
    my $value = $in->{hints}{$key};
    next if !defined $value || ref $value || $key eq 'urgency';
    push @hints, [$key, 's', clean($value, 32768)];
  }
}
fail() if @hints > 16;

# ---------- Marshalling (little-endian D-Bus wire format) ----------

sub pad {
  my ($buf, $n) = @_;
  $$buf .= "\0" x ((-length($$buf)) % $n);
}
sub put_byte { my ($buf, $v) = @_; $$buf .= pack('C', $v) }
sub put_u32 { my ($buf, $v) = @_; pad($buf, 4); $$buf .= pack('V', $v) }
sub put_i32 { my ($buf, $v) = @_; pad($buf, 4); $$buf .= pack('l<', $v) }
sub put_str {
  my ($buf, $text) = @_;
  my $bytes = $text;
  utf8::encode($bytes);
  pad($buf, 4);
  $$buf .= pack('V', length $bytes) . $bytes . "\0";
}
sub put_sig { my ($buf, $sig) = @_; $$buf .= pack('C', length $sig) . $sig . "\0" }

sub put_hints {
  my ($buf, $list) = @_;
  pad($buf, 4);
  my $at = length $$buf;
  $$buf .= pack('V', 0);
  pad($buf, 8);
  my $start = length $$buf;
  for my $hint (@$list) {
    my ($key, $sig, $value) = @$hint;
    pad($buf, 8);
    put_str($buf, $key);
    put_sig($buf, $sig);
    if ($sig eq 'y') { put_byte($buf, $value) }
    else { put_str($buf, $value) }
  }
  substr($$buf, $at, 4) = pack('V', length($$buf) - $start);
}

my $serial = 0;

# A method call: header fields, then a body that starts 8-aligned, so the body's
# own alignment can be counted from its first byte.
sub method_call {
  my (%m) = @_;
  my $body = defined $m{body} ? $m{body} : '';
  my $msg = pack('a1 C C C', 'l', 1, 0, 1) . pack('V', length $body) . pack('V', ++$serial);
  my $at = length $msg;
  $msg .= pack('V', 0);
  pad(\$msg, 8);
  my $start = length $msg;
  my @fields = ([1, 'o', $m{path}], [2, 's', $m{interface}], [3, 's', $m{member}], [6, 's', $m{destination}]);
  push @fields, [8, 'g', $m{signature}] if $m{signature};
  for my $field (@fields) {
    my ($code, $sig, $value) = @$field;
    pad(\$msg, 8);
    put_byte(\$msg, $code);
    put_sig(\$msg, $sig);
    if ($sig eq 'g') { put_sig(\$msg, $value) }
    else { put_str(\$msg, $value) }
  }
  substr($msg, $at, 4) = pack('V', length($msg) - $start);
  pad(\$msg, 8);
  return ($msg . $body, $serial);
}

# ---------- The session bus ----------

sub bus_path {
  for my $entry (split /;/, $ENV{DBUS_SESSION_BUS_ADDRESS} || '') {
    next unless $entry =~ /^unix:(.*)$/;
    my %kv = map { /^([^=]+)=(.*)$/ ? ($1 => $2) : () } split /,/, $1;
    for my $kind ('path', 'abstract') {
      next unless defined $kv{$kind};
      (my $value = $kv{$kind}) =~ s/%([0-9A-Fa-f]{2})/chr(hex $1)/ge;
      return $kind eq 'abstract' ? "\0$value" : $value;
    }
  }
  my $runtime = $ENV{XDG_RUNTIME_DIR} || "/run/user/$<";
  return "$runtime/bus";
}

my $sock = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => bus_path()) or fail();
binmode $sock;
$sock->autoflush(1);

sub send_bytes { print {$sock} $_[0] or fail() }

sub read_exact {
  my ($n) = @_;
  my $buf = '';
  while (length $buf < $n) {
    my $got = read($sock, $buf, $n - length $buf, length $buf);
    fail() unless $got;
  }
  return $buf;
}

# EXTERNAL: the bus checks the socket's peer credentials against this uid.
send_bytes("\0AUTH EXTERNAL " . unpack('H*', "$<") . "\r\n");
my $answer = <$sock>;
fail() unless defined $answer && $answer =~ /^OK /;
send_bytes("BEGIN\r\n");

# Returns the body of the reply to `$want`, or fails on an error reply.
sub reply_to {
  my ($want) = @_;
  while (1) {
    my $fixed = read_exact(16);
    my $endian = substr($fixed, 0, 1);
    fail() unless $endian eq 'l' || $endian eq 'B';
    my $u = $endian eq 'l' ? 'V' : 'N';
    my ($type) = unpack('C', substr($fixed, 1, 1));
    my ($body_len, undef, $fields_len) = unpack("x4 $u $u $u", $fixed);
    fail() if $body_len > 1 << 20 || $fields_len > 1 << 16;
    my $fields = read_exact($fields_len + ((-(16 + $fields_len)) % 8));
    my $body = read_exact($body_len);

    my $reply = 0;
    my $pos = 0;
    while ($pos < $fields_len) {
      $pos += (-$pos) % 8;
      last if $pos >= $fields_len;
      my $code = unpack('C', substr($fields, $pos, 1));
      my $sig_len = unpack('C', substr($fields, $pos + 1, 1));
      my $sig = substr($fields, $pos + 2, $sig_len);
      $pos += 3 + $sig_len;
      if ($sig eq 'u') {
        $pos += (-$pos) % 4;
        my $value = unpack($u, substr($fields, $pos, 4));
        $reply = $value if $code == 5;
        $pos += 4;
      } elsif ($sig eq 's' || $sig eq 'o') {
        $pos += (-$pos) % 4;
        $pos += 4 + unpack($u, substr($fields, $pos, 4)) + 1;
      } elsif ($sig eq 'g') {
        $pos += 1 + unpack('C', substr($fields, $pos, 1)) + 1;
      } else {
        fail();
      }
    }

    next unless ($type == 2 || $type == 3) && $reply == $want;
    # An error reply means nothing was shown, whatever was sent.
    exit 1 if $type == 3;
    return ($body, $u);
  }
}

my ($hello, $hello_serial) = method_call(
  path => '/org/freedesktop/DBus', interface => 'org.freedesktop.DBus',
  member => 'Hello', destination => 'org.freedesktop.DBus');
send_bytes($hello);
reply_to($hello_serial);

# Notify(susssasa{sv}i): app_name, replaces_id, app_icon, summary, body,
# actions (none: buttons ride in the omarchy-actions hint), hints, timeout.
my $args = '';
put_str(\$args, $app);
put_u32(\$args, $replace);
put_str(\$args, '');
put_str(\$args, $summary);
put_str(\$args, $body);
put_u32(\$args, 0);
put_hints(\$args, \@hints);
put_i32(\$args, -1);

my ($notify, $notify_serial) = method_call(
  path => '/org/freedesktop/Notifications', interface => 'org.freedesktop.Notifications',
  member => 'Notify', destination => 'org.freedesktop.Notifications',
  signature => 'susssasa{sv}i', body => $args);
send_bytes($notify);
$sent = 1;

my ($result, $u) = reply_to($notify_serial);
fail() unless length $result >= 4;
print unpack($u, substr($result, 0, 4)), "\n";
exit 0;
