class JobPolicy
  class Scope
    def initialize(user, scope)
      @user = user
      @scope = scope
    end

    def resolve = @user.recruiter? ? @scope : @scope.where(published: true)
  end
end
