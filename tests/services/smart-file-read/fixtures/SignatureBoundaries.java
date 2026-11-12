@interface Tags { String[] value(); }
abstract class SignatureBoundaries {
  @Tags({"{", "header"})
  int read(int value) { return value + 1; }
  @Tags({"{", "constructor"})
  SignatureBoundaries(int value) {}
  abstract int external(int value);
}
