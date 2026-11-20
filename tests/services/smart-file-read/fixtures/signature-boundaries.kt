fun choose(make: () -> Int = { 7 }): Int { return make() }
class Api {
  constructor(make: () -> Int = { 7 }) { make() }
}
interface Contract { fun external(value: Int): Int }
