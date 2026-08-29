class JobSearchService
  SearchResult = Data.define(:jobs, :facets, :query, :page)

  def initialize(user:, query:, page:)
    @user = user
    @query = query
    @page = page
  end

  def call
    scope = JobPolicy::Scope.new(@user, Job.all).resolve
    jobs = scope.search(@query).includes(:company).page(@page)
    facets = scope.facets_for(@query)
    SearchResult.new(jobs:, facets:, query: @query, page: @page)
  end
end
