record Range(int low, int high) {
  /** Validates ordered bounds before assigning components. */
  public Range {
    if (low > high) throw new IllegalArgumentException("reversed bounds");
  }
  Range() { this(0, 0); }
  int width() { return high - low; }
}

record Payload<T>(
  java.util.List<T> values,
  String... labels
) {
  Payload {
    values = java.util.List.copyOf(values);
    labels = labels.clone();
  }
}

class Envelope {
  record Name(String value) {
    Name {
      value = value.strip();
    }
  }
  record Other(String value) {
    Other {
      value = value.toUpperCase(java.util.Locale.ROOT);
    }
  }
}

record Token() {
  Token {
    System.out.println("owned token");
  }
}

class Plain {
  Plain() {}
  Plain(int value) { System.out.println(value); }
}

record Explicit(int value) {
  Explicit(int value) { this.value = value; }
}
