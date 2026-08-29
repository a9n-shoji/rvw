Rails.application.routes.draw do
  resources :jobs, only: [:index]
end
