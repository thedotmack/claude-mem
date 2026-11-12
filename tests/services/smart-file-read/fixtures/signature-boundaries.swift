func choose(make: () -> Int = { 7 }) -> Int { make() }
struct Api {
  init(make: () -> Int = { 7 }) { _ = make() }
}
protocol Contract { init(value: Int) }
