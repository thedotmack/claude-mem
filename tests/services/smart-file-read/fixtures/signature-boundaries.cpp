int choose(int value = [] { return 7; }()) { return value + 1; }
struct Api {
  Api(int value = [] { return 7; }()) : value{value} {}
  int value;
  void gone() = delete;
};
