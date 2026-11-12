struct Hook {
  int (*callback)(int nested(int));
  int value;
};
int (*slot)(int nested(int));
typedef int Callback(int input);
typedef int (*FunctionPointer)(int input);

/** Adds the two public values. */
int add(
  int lhs,
  int rhs
);
char ****message(void);
int apply(int handler(int), int input);
int (*factory(void))(int);
int first(void), second(int value);

int repeated(int value);
int repeated(int value) { return value + 1; }
