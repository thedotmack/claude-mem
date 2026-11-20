object Api {
  def choose(make: () => Int = () => { 7 }): Int = { make() }
}
