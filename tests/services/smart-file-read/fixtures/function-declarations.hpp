namespace api {
class Widget {
public:
  Widget();
  ~Widget();
  int size();
  int size() const;
  const char *name() const;
  static Widget& shared() noexcept;
  bool operator==(const Widget& other) const;
  int (*callback)(int nested(int));
  int value;
};

Widget& remoteFetch();
int tally(int count);
int tally(double count);
template<typename T>
auto identity(
  T value
) -> T;
}
extern "C" {
  int c_linkage(int value);
}
int (*slot)(int nested(int));
